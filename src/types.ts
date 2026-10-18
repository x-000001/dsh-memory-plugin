/**
 * Shared data model for dsh-plugin-memory.
 *
 * Everything persisted by this plugin is either Markdown (memory bodies are
 * plain text inside NDJSON records) or NDJSON (one JSON object per line), so
 * every store stays human-readable, hand-editable, git-diffable and auditable.
 */

/** Physical isolation level. Roots are resolved separately and never aliased. */
export type MemoryLayer = 'project' | 'global' | 'habit'

export type MemoryStatus = 'active' | 'dormant' | 'archived' | 'tombstone'

export type MemoryPriority = 'P0' | 'P1' | 'P2'

export type MemorySource = 'user' | 'auto' | 'habit' | 'import'

export type DisclosedTier = 'full' | 'compact' | 'minimal' | 'single-line' | 'none'

export interface MemoryEntry {
  id: string
  version: number
  layer: MemoryLayer
  /** Project identity: absolute repo root for `project`, `__global__` for global, habit category otherwise. */
  scope: string
  title: string
  tags: string[]
  /** One-line index summary (used by the resident index). */
  summary: string
  /** Full body, Markdown. Only disclosed through memory_recall / memory_expand. */
  body: string
  status: MemoryStatus
  priority: MemoryPriority
  confidence: number
  source: MemorySource
  /** Identity hash of the normalized body; equal hash inside one layer = duplicate. */
  contentHash: string
  tokens: number
  createdAt: number
  updatedAt: number
  expiresAt?: number
  lastRecalledAt?: number
  lastRecalledSession?: string
  recallCount: number
  /** Previous version number this record supersedes (history is kept). */
  supersedes?: number
  flagged?: boolean
}

export interface MemoryWriteInput {
  title: string
  body: string
  tags?: string[]
  priority?: MemoryPriority
  source?: MemorySource
  summary?: string
  scope?: string
  expiresAt?: number
}

export interface RecallOptions {
  query: string
  layer?: MemoryLayer
  tags?: string[]
  maxResults?: number
  maxCharsPerMemory?: number
  maxTotalRecallChars?: number
  /** Explicit opt-in to re-inject entries already disclosed in this session. */
  allowRepeat?: boolean
}

export interface RecallItem {
  id: string
  version: number
  layer: MemoryLayer
  title: string
  summary: string
  excerpt: string
  chars: number
  score: number
  priority: MemoryPriority
  truncated: boolean
}

export interface RecallResult {
  items: RecallItem[]
  tier: DisclosedTier
  degraded: boolean
  degradationReasons: string[]
  spentChars: number
  sessionSpentChars: number
  sessionBudgetChars: number
  dedupedIds: string[]
  hint: string
}

export interface HabitEvidence {
  sessionId: string
  turn: number
  phrase: string
  text: string
  at: number
}

export type HabitCandidateStatus = 'pending' | 'confirmed' | 'discarded' | 'promoted' | 'mature'

export interface HabitCandidate {
  id: string
  status: HabitCandidateStatus
  pattern: string
  category: string
  confidence: number
  evidence: HabitEvidence[]
  sessions: string[]
  createdAt: number
  updatedAt: number
  /** Set by the judgment step: `auto` is never assigned by the model alone. */
  judgedBy: 'judge' | 'rule' | 'none'
  note?: string
}

export type HabitProfileStatus = 'suggested' | 'auto' | 'disabled'

export interface HabitProfile {
  id: string
  status: HabitProfileStatus
  pattern: string
  category: string
  confidence: number
  evidenceCount: number
  sessions: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface HabitTombstone {
  id: string
  pattern: string
  at: number
  reason: string
}

export type AuditType =
  | 'remember'
  | 'dedupe'
  | 'supersede'
  | 'recall'
  | 'expand'
  | 'forget'
  | 'consolidate'
  | 'compact'
  | 'feedback'
  | 'index-inject'
  | 'first-disclosure'
  | 'harness-error'
  | 'write-guard-reject'
  | 'cross-layer-reject'
  | 'habit-signal'
  | 'habit-candidate'
  | 'habit-confirm'
  | 'habit-promote'
  | 'habit-discard'
  | 'habit-delete'
  | 'judge'
  | 'degradation'
  | 'health'

export interface AuditEvent {
  seq: number
  ts: number
  type: AuditType
  actor: 'user' | 'agent' | 'system'
  sessionId?: string
  entryId?: string
  layer?: MemoryLayer
  /** Short human readable detail. Must never contain a credential value. */
  detail: string
  /** Integrity chain: sha256(prev.hash + canonical payload). */
  prevHash: string
  hash: string
}

export type HealthStatus = 'active' | 'degraded' | 'unavailable'

export interface HealthReason {
  code: string
  message: string
  scope: string
}

export interface HealthSnapshot {
  status: HealthStatus
  reasons: HealthReason[]
  features: Record<string, boolean>
  updatedAt: number
  /** Where the visible state file lives. */
  stateFile: string
}

export interface GuardViolation {
  line: number
  pattern: string
}

export interface GuardResult {
  ok: boolean
  violations: GuardViolation[]
}

/** Budget knobs. Every value is configurable; the degradation order is fixed. */
export interface BudgetSettings {
  indexMaxLines: number
  indexMaxLineChars: number
  indexMaxChars: number
  recallMaxResults: number
  recallMaxCharsPerMemory: number
  recallMaxTotalChars: number
  recallSessionBudgetChars: number
  habitPromptMaxChars: number
  unloadThresholdChars: number
  degradeOrder: DisclosedTier[]
}

export interface LifecycleSettings {
  expireDays: number
  dormantDays: number
  weakRecallDays: number
  capacity: number
  /** Priorities exempt from eviction and physical deletion. */
  protectedPriorities: MemoryPriority[]
  userMemoryProtected: boolean
}

export interface HabitSettings {
  enabled: boolean
  threshold: number
  maxEvidence: number
  judgeEnabled: boolean
  judgeTimeoutMs: number
  judgeModel: string
  /** Optional provider route for the judge call; empty means no judge. */
  judgeProvider?: string
  /** Same pattern must appear in this many distinct sessions before `auto` is allowed. */
  minSessionsForAuto: number
}

export interface GuardSettings {
  extraDenyPatterns: string[]
  blockEnvAssignments: boolean
}

export interface MemoryPluginConfig {
  projectMemoryDir: string
  globalMemoryDir: string
  habitDir: string
  budget: BudgetSettings
  lifecycle: LifecycleSettings
  habit: HabitSettings
  guard: GuardSettings
  /** Keep the injected index byte-identical across turns unless it actually changes. */
  cacheStable: boolean
  logLevel: 'silent' | 'error' | 'info' | 'debug'
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function firstSentence(text: string, maxChars = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxChars) return clean
  const cut = clean.slice(0, maxChars)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('; '))
  return (stop > 20 ? cut.slice(0, stop + 1) : cut).trim() + (stop > 20 ? '' : '...')
}

export function shortId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const t = Date.now().toString(36).slice(-4)
  return `${prefix}_${t}${rand}`
}
