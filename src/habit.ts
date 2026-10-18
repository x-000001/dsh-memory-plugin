/**
 * Habit learning pipeline (deterministic, auditable, two human gates):
 *
 *   session events -> deterministic correction detection (zero tokens)
 *   -> threshold in one session (default 3) -> ONE cheap judge call
 *   -> pending candidate (NO injection)
 *   -> gate 1: user confirm -> habit profile `suggested` (still NO injection)
 *   -> gate 2: user promote -> `auto` (now injected)
 *
 * Hard boundary: no model output can set `auto`. Only `promote()` with
 * actor 'user' does that, and only after the pattern appears in
 * `minSessionsForAuto` distinct sessions. Deletion writes a tombstone and the
 * pattern is never learned again.
 */
import type { HabitJudge } from './judge.ts'
import type { MemoryEngine } from './memory.ts'
import type { HabitCandidate, HabitEvidence, HabitProfile, HabitSettings, HabitTombstone } from './types.ts'
import { shortId } from './types.ts'

export interface CorrectionHit {
  phrase: string
  text: string
}

/** Fixed, configurable-by-code list. Matching is literal + case-insensitive. */
export const CORRECTION_PHRASES: string[] = [
  '不对',
  '不是这样',
  '不是这个意思',
  '你理解错了',
  '你搞错了',
  '错了',
  '重新来',
  '重来',
  '别再',
  '不要这样',
  '不要用',
  '别用',
  '应该是',
  '我说的是',
  '我指的是',
  '按我说的',
  'wrong',
  'not what i',
  'i meant',
  'you misunderstood',
  'stop doing',
  "don't do",
  'do not do',
  'instead use',
  'actually, use',
  'no, use',
]

const TASK_PREFIX = /^(?:请帮我|帮我|给我|实现|添加|新增|修复|写入|创建|设计|做个|开发|重构|删除|add|implement|fix|create|write|build|design|refactor|remove|update)\b/i

/**
 * Deterministic correction detection. A sentence counts only when:
 * - it contains one of the fixed phrases,
 * - it is short enough to be a correction (<= 400 chars by default),
 * - it is not a pure task description (task verbs at the head do not count).
 */
export function detectCorrections(text: string, maxSegmentChars = 400): CorrectionHit[] {
  const hits: CorrectionHit[] = []
  const segments = text
    .split(/\r?\n|(?<=[。！？!?])\s*|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const segment of segments) {
    if (segment.length > maxSegmentChars) continue
    const lowered = segment.toLowerCase()
    const phrase = CORRECTION_PHRASES.find((p) => lowered.includes(p.toLowerCase()))
    if (!phrase) continue
    if (TASK_PREFIX.test(segment) && !CORRECTION_PHRASES.some((p) => lowered.startsWith(p.toLowerCase()))) continue
    hits.push({ phrase, text: segment.slice(0, maxSegmentChars) })
  }
  return hits
}

export interface ObserveResult {
  detected: number
  sessionCount: number
  triggered: boolean
  candidateId?: string
  judge: 'judged' | 'rule' | 'none' | 'skipped'
  reason?: string
}

export interface HabitReview {
  candidates: HabitCandidate[]
  profiles: HabitProfile[]
  tombstones: HabitTombstone[]
  threshold: number
  minSessionsForAuto: number
  judgeEnabled: boolean
  gate1: string
  gate2: string
  policy: string
}

export class HabitEngine {
  private readonly store: MemoryEngine['store']
  private readonly memory: MemoryEngine
  private readonly settings: HabitSettings
  private readonly judge: HabitJudge
  private readonly now: () => number
  private readonly onJudgeFailure?: (reason: string) => void
  private readonly onJudgeSuccess?: () => void

  constructor(options: {
    store: MemoryEngine['store']
    memory: MemoryEngine
    settings: HabitSettings
    judge: HabitJudge
    now?: () => number
    onJudgeFailure?: (reason: string) => void
    onJudgeSuccess?: () => void
  }) {
    this.store = options.store
    this.memory = options.memory
    this.settings = options.settings
    this.judge = options.judge
    this.now = options.now ?? Date.now
    this.onJudgeFailure = options.onJudgeFailure
    this.onJudgeSuccess = options.onJudgeSuccess
  }

  /** Feed one user-authored message. Pure bookkeeping + at most one judge call. */
  async observe(sessionId: string, turn: number, text: string): Promise<ObserveResult> {
    if (!this.settings.enabled) return { detected: 0, sessionCount: 0, triggered: false, judge: 'skipped', reason: 'habit learning disabled by config' }
    const hits = detectCorrections(text)
    if (!hits.length) return { detected: 0, sessionCount: 0, triggered: false, judge: 'none' }
    const at = this.now()
    for (const hit of hits) {
      this.store.appendHabitSignal({ sessionId, turn, phrase: hit.phrase, text: hit.text, at })
    }
    this.store.appendAudit({
      type: 'habit-signal',
      actor: 'system',
      sessionId,
      detail: `${hits.length} correction signal(s): ${hits.map((h) => h.phrase).join(', ')}`,
    })
    const sessionSignals = this.store.readHabitSignals().filter((s) => s.sessionId === sessionId)
    const sessionCount = sessionSignals.length
    const triggered = this.store.readHabitTriggers()
    if (sessionCount < this.settings.threshold || triggered.includes(sessionId)) {
      return { detected: hits.length, sessionCount, triggered: false, judge: 'none' }
    }

    const evidence = sessionSignals.slice(-this.settings.maxEvidence).map((s) => s.text)
    const existing = this.store.readHabitProfiles().filter((p) => p.status !== 'disabled').map((p) => p.pattern)
    this.store.appendHabitTrigger(sessionId)
    const outcome = await this.judge.judge({ evidence, existingHabits: existing })
    let judgedBy: HabitCandidate['judgedBy'] = 'none'
    let isHabit = false
    let pattern = ''
    let confidence = 0.35
    let category = 'other'
    let note = ''

    if (outcome.ok) {
      this.onJudgeSuccess?.()
      judgedBy = 'judge'
      isHabit = outcome.verdict.isHabit && outcome.verdict.confidence >= 0.5
      pattern = outcome.verdict.pattern
      confidence = outcome.verdict.confidence
      category = outcome.verdict.category
      this.store.appendAudit({
        type: 'judge',
        actor: 'system',
        sessionId,
        detail: `isHabit=${outcome.verdict.isHabit} confidence=${outcome.verdict.confidence} pattern="${pattern.slice(0, 80)}"`,
      })
    } else {
      // Fail open: the judge being unavailable never blocks the pipeline, but
      // rule mode can only *propose* a low-confidence pending candidate.
      this.onJudgeFailure?.(outcome.reason)
      judgedBy = 'rule'
      isHabit = true
      const last = hits[hits.length - 1] ?? { phrase: 'correction', text }
      pattern = last.text.slice(0, 120)
      confidence = 0.35
      note = `judge unavailable/failed (${outcome.reason}); rule fallback`
      this.store.appendAudit({
        type: 'judge',
        actor: 'system',
        sessionId,
        detail: `fail-open: ${outcome.reason}`,
      })
    }

    if (!isHabit) {
      return { detected: hits.length, sessionCount, triggered: true, judge: judgedBy as ObserveResult['judge'], reason: 'judge decided this is not a stable habit' }
    }
    if (this.isTombstoned(pattern)) {
      return { detected: hits.length, sessionCount, triggered: true, judge: judgedBy as ObserveResult['judge'], reason: 'pattern was deleted by the user (tombstone); not learned again' }
    }

    const state = this.store.loadHabitState()
    const prior = state.candidates.find(
      (c) => c.status !== 'discarded' && normalize(c.pattern) === normalize(pattern),
    )
    const sessions = [...new Set([...(prior?.sessions ?? []), sessionId])]
    const atNow = this.now()
    const candidate: HabitCandidate = {
      id: prior?.id ?? shortId('cand'),
      status: 'pending',
      pattern,
      category,
      confidence,
      evidence: [...(prior?.evidence ?? []), ...sessionSignals.slice(-this.settings.maxEvidence)].slice(-this.settings.maxEvidence),
      sessions,
      createdAt: prior?.createdAt ?? atNow,
      updatedAt: atNow,
      judgedBy,
      note: note || prior?.note,
    }
    state.candidates = [...state.candidates.filter((c) => c.id !== candidate.id), candidate]
    this.store.saveHabitState(state)
    this.store.appendAudit({
      type: 'habit-candidate',
      actor: 'system',
      sessionId,
      entryId: candidate.id,
      detail: `pending candidate (${judgedBy}, confidence ${confidence}, sessions ${sessions.length}); no injection until two human gates`,
    })
    return { detected: hits.length, sessionCount, triggered: true, candidateId: candidate.id, judge: judgedBy as ObserveResult['judge'] }
  }

  review(): HabitReview {
    const state = this.store.loadHabitState()
    return {
      candidates: state.candidates,
      profiles: this.store.readHabitProfiles(),
      tombstones: state.tombstones,
      threshold: this.settings.threshold,
      minSessionsForAuto: this.settings.minSessionsForAuto,
      judgeEnabled: this.judge.enabled,
      gate1: 'user confirm: pending -> suggested (still not injected)',
      gate2: 'user promote: suggested -> auto (injected; requires >= minSessionsForAuto distinct sessions)',
      policy: 'models can never promote habits; only explicit user actions call confirm/promote',
    }
  }

  /** Gate 1. */
  confirm(candidateId: string, actor: 'user' | 'agent'): { ok: boolean; reason: string; profile?: HabitProfile } {
    if (actor !== 'user') return { ok: false, reason: 'gate 1 requires a user action; the agent cannot confirm habits' }
    const state = this.store.loadHabitState()
    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) return { ok: false, reason: `candidate not found: ${candidateId}` }
    if (candidate.status !== 'pending') return { ok: false, reason: `candidate ${candidateId} is ${candidate.status}, expected pending` }
    const now = this.now()
    const profile: HabitProfile = {
      id: candidate.id,
      status: 'suggested',
      pattern: candidate.pattern,
      category: candidate.category,
      confidence: candidate.confidence,
      evidenceCount: candidate.evidence.length,
      sessions: candidate.sessions,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    }
    candidate.status = 'confirmed'
    candidate.updatedAt = now
    this.store.saveHabitState(state)
    const profiles = this.store.readHabitProfiles().filter((p) => p.id !== profile.id)
    profiles.push(profile)
    this.store.rewriteHabitProfiles(profiles)
    this.memory.upsertHabitMemory(profile)
    this.store.appendAudit({ type: 'habit-confirm', actor, entryId: candidateId, detail: 'gate 1 passed: suggested (not injected)' })
    return { ok: true, reason: 'confirmed as suggested; not injected until the second gate', profile }
  }

  /** Gate 2. */
  promote(candidateId: string, actor: 'user'): { ok: boolean; reason: string; profile?: HabitProfile } {
    if (actor !== 'user') return { ok: false, reason: 'gate 2 requires a user action; the model can never promote habits' }
    const state = this.store.loadHabitState()
    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) return { ok: false, reason: `candidate not found: ${candidateId}` }
    if (candidate.status !== 'confirmed') return { ok: false, reason: `gate 2 requires a confirmed candidate first (current: ${candidate.status})` }
    if (candidate.sessions.length < this.settings.minSessionsForAuto) {
      return {
        ok: false,
        reason: `cross-session guardrail: pattern seen in ${candidate.sessions.length} session(s); need ${this.settings.minSessionsForAuto} distinct sessions before auto`,
      }
    }
    const now = this.now()
    const profiles = this.store.readHabitProfiles()
    const profile = profiles.find((p) => p.id === candidate.id)
    if (!profile) return { ok: false, reason: 'habit profile missing; confirm the candidate first' }
    profile.status = 'auto'
    profile.updatedAt = now
    this.store.rewriteHabitProfiles(profiles)
    candidate.status = 'mature'
    candidate.updatedAt = now
    this.store.saveHabitState(state)
    this.memory.upsertHabitMemory(profile)
    this.store.appendAudit({ type: 'habit-promote', actor, entryId: candidate.id, detail: 'gate 2 passed: auto (now injected)' })
    return { ok: true, reason: 'promoted to auto; habit is now injected', profile }
  }

  discard(candidateId: string, actor: 'user' | 'agent'): { ok: boolean; reason: string } {
    const state = this.store.loadHabitState()
    const candidate = state.candidates.find((c) => c.id === candidateId)
    if (!candidate) return { ok: false, reason: `candidate not found: ${candidateId}` }
    candidate.status = 'discarded'
    candidate.updatedAt = this.now()
    this.store.saveHabitState(state)
    const profiles = this.store.readHabitProfiles()
    const profile = profiles.find((p) => p.id === candidateId)
    if (profile) {
      profile.status = 'disabled'
      profile.updatedAt = this.now()
      this.store.rewriteHabitProfiles(profiles)
      this.memory.disableHabitMemory(profile)
    }
    this.store.appendAudit({ type: 'habit-discard', actor, entryId: candidateId, detail: 'candidate discarded by user' })
    return { ok: true, reason: 'discarded; never injected' }
  }

  /** Manual delete writes a tombstone; the pattern is not learned again. */
  deleteProfile(profileId: string, actor: 'user'): { ok: boolean; reason: string } {
    if (actor !== 'user') return { ok: false, reason: 'deleting a habit requires an explicit user action' }
    const profiles = this.store.readHabitProfiles()
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) return { ok: false, reason: `habit profile not found: ${profileId}` }
    profile.status = 'disabled'
    profile.updatedAt = this.now()
    this.store.rewriteHabitProfiles(profiles)
    this.memory.disableHabitMemory(profile)
    const tombstone = this.store.addHabitTombstone(profile.pattern, 'deleted by user')
    const state = this.store.loadHabitState()
    const candidate = state.candidates.find((c) => c.id === profileId)
    if (candidate) {
      candidate.status = 'discarded'
      candidate.updatedAt = this.now()
      this.store.saveHabitState(state)
    }
    this.store.appendAudit({ type: 'habit-delete', actor, entryId: profileId, detail: `tombstone ${tombstone.id}` })
    return { ok: true, reason: 'habit deleted and tombstoned; pattern will not be learned again' }
  }

  isTombstoned(pattern: string): boolean {
    const needle = normalize(pattern)
    return this.store.loadHabitState().tombstones.some((t) => normalize(t.pattern) === needle)
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}
