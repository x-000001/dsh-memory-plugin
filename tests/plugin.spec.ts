/**
 * Acceptance tests for dsh-memory. Everything runs with node:test and the
 * TypeScript sources directly (Node >= 22.6 type stripping); no network, no
 * model, no vector backend, no DSH runtime required.
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createHarness, fakeJudge, failingJudge, feedCorrections, HABIT_VERDICT } from './harness.ts'
import { detectCorrections, CORRECTION_PHRASES } from '../src/habit.ts'
import { planIndex, formatIndexLine, indexLimitsFor } from '../src/budget.ts'
import { DEFAULT_BUDGET, DEFAULT_CONFIG } from '../src/config.ts'
import { buildDisclosure, MEMORY_TOOLS, StablePrefix, MEMORY_NOT_INSTRUCTIONS } from '../src/inject.ts'
import { GuardRejection } from '../src/memory.ts'
import { WriteGuard } from '../src/guard.ts'
import { CrossLayerWriteError } from '../src/storage.ts'
import { checkInvariants } from '../src/invariant.ts'

const SECRET = 'sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv'

function projectEntries(harness: ReturnType<typeof createHarness>) {
  return harness.runtime.require().memory.findAllCurrent('project')
}

// ---------------------------------------------------------------------------
// 1. Writes, project-scoped recall, versioning, dedupe
// ---------------------------------------------------------------------------

test('project memory: write, dedupe, version history and recall', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()

  const first = memory.write({ title: 'Build command', body: 'Use pnpm build before tests.', tags: ['build'] }, 'project', 'user', 's1')
  assert.equal(first.version, 1)
  assert.equal(first.id, memory.findAllCurrent('project')[0]!.id)

  const duplicate = memory.write({ title: 'Build command', body: 'Use pnpm build before tests.' }, 'project', 'user', 's1')
  assert.equal(duplicate.deduped, true)
  assert.equal(duplicate.version, 1)

  const second = memory.write({ title: 'Build command', body: 'Use pnpm -r build for the workspace.' }, 'project', 'user', 's1')
  assert.equal(second.version, 2)
  assert.equal(second.id, first.id)
  assert.equal(second.superseded, 1)

  const history = harness.runtime.require().store.readLayer('project').filter((entry) => entry.id === first.id)
  assert.equal(history.length, 2)
  assert.equal(history.some((entry) => entry.status === 'archived'), true)

  const recall = memory.recall({ sessionId: 's1', query: 'how do we build' })
  assert.equal(recall.items.length, 1)
  assert.equal(recall.items[0]!.version, 2)
  assert.match(recall.items[0]!.excerpt, /pnpm -r build/)
})

test('recall is bounded, deduped per session and degrades in the configured order', async (t) => {
  const harness = createHarness({
    config: {
      budget: {
        ...DEFAULT_BUDGET,
        recallSessionBudgetChars: 260,
        recallMaxTotalChars: 220,
        recallMaxResults: 4,
        recallMaxCharsPerMemory: 120,
      },
    },
  })
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  for (let index = 0; index < 6; index += 1) {
    memory.write(
      { title: `Widget ${index}`, body: `Widget ${index} uses the alpha pipeline and the beta renderer for ${index}.`.repeat(3), tags: ['widget'] },
      'project',
      'user',
      's1',
    )
  }

  const first = memory.recall({ sessionId: 's1', query: 'widget alpha pipeline' })
  assert.ok(first.items.length > 0)
  assert.ok(first.spentChars <= 220)
  assert.ok(first.sessionSpentChars <= 260)

  const second = memory.recall({ sessionId: 's1', query: 'widget alpha pipeline' })
  assert.equal(second.items.length, 0)
  assert.equal(second.dedupedIds.length > 0, true)

  let last = first
  for (let round = 0; round < 4 && last.sessionSpentChars < 260; round += 1) {
    last = memory.recall({ sessionId: 's2' + round, query: 'widget alpha pipeline', allowRepeat: false })
  }
  const tight = memory.recall({ sessionId: 's1', query: 'widget beta renderer', allowRepeat: true })
  assert.equal(tight.degraded, true)
  assert.match(tight.degradationReasons.join(','), /session-recall-budget/)
  assert.ok(['compact', 'minimal', 'single-line', 'none'].includes(tight.tier))
})

// ---------------------------------------------------------------------------
// 2. Layered isolation and cross-project behavior
// ---------------------------------------------------------------------------

test('layers are physically isolated and cross-layer writes are blocked', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory, store } = harness.runtime.require()

  const projectWrite = memory.write({ title: 'Project fact', body: 'Only for this repo.' }, 'project', 'user', 's1')
  const globalWrite = memory.write({ title: 'Global preference', body: 'Always answer in Chinese.' }, 'global', 'user', 's1')

  assert.notEqual(store.layerRoot('project'), store.layerRoot('global'))
  assert.throws(
    () => store.appendEntry('project', { ...projectWrite, id: projectWrite.id, layer: 'global', version: 9 } as any),
    CrossLayerWriteError,
  )
  assert.equal(memory.findAllCurrent('global').some((entry) => entry.id === projectWrite.id), false)
  assert.equal(globalWrite.layer, 'global')
  assert.equal(memory.findAllCurrent('global')[0]!.id, globalWrite.id)

  // promotion needs explicit user confirmation
  const unconfirmed = memory.promoteToGlobal(projectWrite.id, false, 'agent')
  assert.equal(unconfirmed.ok, false)
  const promoted = memory.promoteToGlobal(projectWrite.id, true, 'user')
  assert.equal(promoted.ok, true)
  assert.equal(memory.findAllCurrent('global').some((entry) => entry.title === 'Project fact'), true)

  const roots = checkInvariants()
  assert.ok(roots.some((invariant) => invariant.id === 'roots-separated' && invariant.ok))
})

test('project memory does not leak across projects, global memory does', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const a = harness.runtime.require().memory
  a.write({ title: 'Repo A only', body: 'The alpha-service lives in repo A.' }, 'project', 'user', 's1')
  a.write({ title: 'Personal preference', body: 'I prefer concise commit messages everywhere.' }, 'global', 'user', 's1')

  const b = harness.open('b').require().memory
  const projectRecall = b.recall({ sessionId: 'b1', query: 'where does the alpha-service live' })
  assert.equal(projectRecall.items.some((item) => item.title === 'Repo A only'), false)
  const globalRecall = b.recall({ sessionId: 'b1', query: 'commit message preference' })
  assert.equal(globalRecall.items.some((item) => item.title === 'Personal preference'), true)
  // irrelevant queries inject nothing
  const unrelated = b.recall({ sessionId: 'b1', query: 'kubernetes ingress tls certificate rotation' })
  assert.equal(unrelated.items.length, 0)
})

// ---------------------------------------------------------------------------
// 3. Progressive disclosure: bounded index, byte-stable prefix, fixed tools
// ---------------------------------------------------------------------------

test('index respects the hard budget and stays byte-identical without changes', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  for (let index = 0; index < 40; index += 1) {
    memory.write(
      { title: `Entry ${index} with a fairly long title to force truncation`, body: `Body ${index}. ` + 'detail '.repeat(60), tags: ['bulk'] },
      'project',
      'user',
      's1',
    )
  }
  const settings = { ...DEFAULT_BUDGET, indexMaxLines: 6, indexMaxLineChars: 60, indexMaxChars: 400 }
  const entries = memory.findAllCurrent('project')
  const plan = planIndex(entries, settings, 'full')
  assert.ok(plan.lines.length <= 6)
  assert.ok(plan.lines.every((line) => line.length <= 60))
  assert.ok(plan.chars <= 400)
  assert.ok(plan.omitted > 0)
  assert.match(plan.lines[0]!, /mmem_|mem_/)

  const single = planIndex(entries, settings, 'single-line')
  assert.equal(single.lines.length, 1)

  const limits = indexLimitsFor(settings, 'minimal')
  assert.equal(limits.minPriority, 'P1')

  const first = harness.runtime.refresh()
  const second = harness.runtime.refresh()
  assert.equal(first.hash, second.hash)
  assert.equal(first.text, second.text)
  assert.ok(first.text.includes(MEMORY_NOT_INSTRUCTIONS))

  memory.write({ title: 'New fact', body: 'This changes the index.', priority: 'P1' }, 'project', 'user', 's1')
  const third = harness.runtime.refresh()
  assert.notEqual(third.hash, first.hash)

  assert.equal(MEMORY_TOOLS.length, 8)
  const disclosure = buildDisclosure({ entries, habits: [], config: harness.runtime.config, tier: 'full' })
  assert.ok(disclosure.text.length > 0)
  const prefix = new StablePrefix()
  const one = prefix.update(first, 'sig-1')
  const two = prefix.update(first, 'sig-1')
  assert.equal(one.changed, true)
  assert.equal(two.changed, false)
  assert.equal(one.hash, two.hash)
})

// ---------------------------------------------------------------------------
// 4. Zero-LLM core + durable state + audit chain
// ---------------------------------------------------------------------------

test('zero-LLM mode: write/recall/expand/forget/consolidate all work', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const { memory } = runtime.require()
  assert.equal(runtime.judge.enabled, false)

  const written = memory.write({ title: 'No model needed', body: 'Retrieval is keyword based.', source: 'auto' }, 'project', 'user', 's1')
  const recalled = memory.recall({ sessionId: 's1', query: 'retrieval keyword' })
  assert.equal(recalled.items.length, 1)
  const expanded = memory.expand(written.id, 's1')
  assert.equal(expanded.found, true)
  assert.match(String(expanded.body), /keyword based/)

  memory.feedback(written.id, 'useful', 'agent')
  const forgotten = memory.forget(written.id, 'user', 'obsolete')
  assert.equal(forgotten.ok, true)
  assert.equal(memory.findAllCurrent('project').some((entry) => entry.id === written.id), false)
  assert.deepEqual(memory.consolidate().deleted, 0)

  const report = runtime.statusReport('s1')
  assert.equal(report.zeroLlm, true)
  assert.equal((report.judge as any).enabled, false)
  assert.equal(runtime.health.snapshot().status, 'active')
})

test('durable state survives a runtime restart and the audit chain verifies', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const first = harness.runtime.require()
  first.memory.write({ title: 'Durable fact', body: 'This must survive a restart.' }, 'project', 'user', 's1')

  const second = harness.open('a').require()
  const recall = second.memory.recall({ sessionId: 's2', query: 'survive restart' })
  assert.equal(recall.items.length, 1)
  assert.equal(second.store.verifyAuditChain(), null)
  assert.ok(second.store.readAudit().length > 0)

  // Tampering is detected with the offending sequence number.
  appendFileSync(second.store.auditFile, JSON.stringify({ seq: 999, ts: 0, type: 'remember', actor: 'agent', detail: 'tampered' }) + '\n')
  const third = harness.open('a').require()
  assert.equal(third.store.verifyAuditChain(), 999)
})

// ---------------------------------------------------------------------------
// 5. Write-guard: reject credentials without echoing them
// ---------------------------------------------------------------------------

test('credential patterns are rejected per line without echoing values', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const { memory } = runtime.require()
  const body = `first line is fine\napi_key=${SECRET}\nlast line`
  assert.throws(
    () => memory.write({ title: 'Leaky note', body }, 'project', 'user', 's1'),
    (error: unknown) => {
      assert.ok(error instanceof GuardRejection)
      assert.match(error.message, /line 3/)
      assert.match(error.message, /openai-sk-key/)
      assert.equal(error.message.includes(SECRET), false)
      return true
    },
  )
  runtime.noteGuardRejection(
    new GuardRejection('write-guard: line 2 matches openai-sk-key', [{ line: 2, pattern: 'openai-sk-key' }]),
  )
  const snapshot = runtime.health.snapshot()
  assert.equal(snapshot.status, 'degraded')
  assert.ok(JSON.stringify(snapshot).includes('write-guard-rejected'))
  const warning = runtime.health.warningLine()
  assert.match(warning, /DEGRADED/)
  assert.match(warning, /write-guard-rejected/)
  assert.equal(warning.includes(SECRET), false)

  const audit = JSON.stringify(runtime.require().store.readAudit())
  assert.equal(audit.includes(SECRET), false)
  assert.match(audit, /write-guard-reject/)

  const guard = new WriteGuard({ extraDenyPatterns: [] })
  assert.equal(guard.scan('AKIAIOSFODNN7EXAMPLE').ok, false)
  assert.equal(guard.scan('ghp_1234567890abcdefghijklmnopqrstuvwxyz').ok, false)
  assert.equal(guard.scan('Bearer abcdefghijklmnopqrstuvwxyz').ok, false)
  assert.equal(guard.scan('password=hunter2').ok, false)
  assert.equal(guard.scan('plain prose about memory budgets').ok, true)
})

// ---------------------------------------------------------------------------
// 6. Failure visibility: index failure + storage unavailable
// ---------------------------------------------------------------------------

test('index build failure is reported as degraded with a visible reason', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  runtime.require().memory.write({ title: 'Visible', body: 'Index failure fallback.' }, 'project', 'user', 's1')
  const findAll = runtime.memory!.findAllCurrent.bind(runtime.memory)
  ;(runtime.memory as any).findAllCurrent = () => {
    throw new Error('index backend crashed')
  }
  const block = runtime.refresh(true)
  assert.equal(block.tier, 'single-line')
  const snapshot = runtime.health.snapshot()
  assert.equal(snapshot.status, 'degraded')
  const warning = runtime.health.warningLine()
  assert.match(warning, /index-build-failed/)
  assert.match(warning, /index backend crashed/)
  ;(runtime.memory as any).findAllCurrent = findAll
})

test('unavailable storage surfaces a fatal warning and never throws at startup', async (t) => {
  const blocked = join(tmpdir(), `dsh-memory-blocked-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  writeFileSync(blocked, 'not a directory', 'utf8')
  const harness = createHarness({ config: { globalMemoryDir: blocked } })
  t.after(() => {
    harness.cleanup()
    try {
      writeFileSync(blocked, '', 'utf8')
    } catch {
      // best effort
    }
  })
  const runtime = harness.runtime
  assert.equal(runtime.available, false)
  assert.throws(() => runtime.require())
  const snapshot = runtime.health.snapshot()
  assert.equal(snapshot.status, 'unavailable')
  assert.match(runtime.health.warningLine(), /UNAVAILABLE/)
  const report = runtime.statusReport('s1')
  assert.equal(report.ok, false)
  assert.ok(String(report.warning).length > 0)
})

// ---------------------------------------------------------------------------
// 7. Habit pipeline: deterministic -> threshold -> candidate -> two gates
// ---------------------------------------------------------------------------

test('correction detection is deterministic and ignores task descriptions', () => {
  assert.equal(CORRECTION_PHRASES.length >= 20, true)
  assert.equal(detectCorrections('不对，应该用 tabs。').length, 1)
  assert.equal(detectCorrections('不是这样，我说的是 rtk。').length, 1)
  assert.equal(detectCorrections('实现一个插件，用 tabs 缩进。').length, 0)
  assert.equal(detectCorrections('x'.repeat(500) + '不对').length, 0)
  assert.equal(detectCorrections('You misunderstood; I meant the local branch.').length, 1)
})

test('habit loop: threshold -> one judge call -> pending candidate -> suggested -> auto', async (t) => {
  const judge = fakeJudge(HABIT_VERDICT)
  const harness = createHarness({ config: { habit: { ...DEFAULT_CONFIG.habit, judgeEnabled: true } }, llmCaller: judge.caller })
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const habit = runtime.require().habit

  await feedCorrections(runtime, 'session-a', 2)
  assert.equal(judge.calls(), 0, 'below threshold: no model call')
  await feedCorrections(runtime, 'session-a', 1)
  assert.equal(judge.calls(), 1, 'threshold reached: exactly one call')

  const pending = habit.review().candidates
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.status, 'pending')
  assert.equal(pending[0]!.judgedBy, 'judge')
  assert.equal(runtime.profiles().length, 0, 'candidate is not a profile')
  assert.equal(runtime.refresh().text.includes('prefer tabs'), false, 'pending candidate is not injected')

  await feedCorrections(runtime, 'session-b', 3)
  assert.equal(judge.calls(), 2, 'one judge call per session')

  const gate1 = habit.confirm(pending[0]!.id, 'user')
  assert.equal(gate1.ok, true)
  assert.equal(runtime.profiles()[0]!.status, 'suggested')
  assert.equal(runtime.refresh().text.includes('prefer tabs'), false, 'suggested habit is not injected')

  const agentPromote = habit.promote(pending[0]!.id, 'agent' as any)
  assert.equal(agentPromote.ok, false)
  assert.match(agentPromote.reason, /model can never promote/)

  const gate2 = habit.promote(pending[0]!.id, 'user')
  assert.equal(gate2.ok, true, gate2.reason)
  assert.equal(runtime.profiles()[0]!.status, 'auto')
  assert.equal(runtime.refresh().text.includes('prefer tabs'), true, 'auto habit is injected')
})

test('cross-session guardrail blocks auto before two distinct sessions', async (t) => {
  const judge = fakeJudge(HABIT_VERDICT)
  const harness = createHarness({ config: { habit: { ...DEFAULT_CONFIG.habit, judgeEnabled: true } }, llmCaller: judge.caller })
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const habit = runtime.require().habit
  await feedCorrections(runtime, 'only-session', 3)
  const candidate = habit.review().candidates[0]!
  assert.equal(habit.confirm(candidate.id, 'user').ok, true)
  const promote = habit.promote(candidate.id, 'user')
  assert.equal(promote.ok, false)
  assert.match(promote.reason, /cross-session guardrail/)
  assert.equal(runtime.profiles()[0]!.status, 'suggested')
  assert.equal(runtime.refresh().text.includes('prefer tabs'), false)
})

test('judge failure fails open into rule mode and is reported as degraded', async (t) => {
  const failing = failingJudge('judge model unavailable')
  const harness = createHarness({ config: { habit: { ...DEFAULT_CONFIG.habit, judgeEnabled: true } }, llmCaller: failing.caller })
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  await feedCorrections(runtime, 'fail-open', 3)
  assert.equal(failing.calls(), 1)
  const candidate = runtime.require().habit.review().candidates[0]!
  assert.equal(candidate.judgedBy, 'rule')
  assert.match(String(candidate.note), /fail-open|judge/)
  const snapshot = runtime.health.snapshot()
  assert.equal(snapshot.status, 'degraded')
  assert.match(runtime.health.warningLine(), /judge/)
  assert.equal(runtime.refresh().text.includes(candidate.pattern), false)
})

test('manual delete writes a tombstone and the pattern is not learned again', async (t) => {
  const judge = fakeJudge(HABIT_VERDICT)
  const harness = createHarness({ config: { habit: { ...DEFAULT_CONFIG.habit, judgeEnabled: true } }, llmCaller: judge.caller })
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const habit = runtime.require().habit
  await feedCorrections(runtime, 's-a', 3)
  await feedCorrections(runtime, 's-b', 3)
  const candidate = habit.review().candidates[0]!
  habit.confirm(candidate.id, 'user')
  assert.equal(habit.promote(candidate.id, 'user').ok, true)
  const profile = runtime.profiles()[0]!

  const deleted = habit.deleteProfile(profile.id, 'user')
  assert.equal(deleted.ok, true)
  assert.equal(runtime.profiles()[0]!.status, 'disabled')
  assert.equal(runtime.refresh().text.includes('prefer tabs'), false)

  await feedCorrections(runtime, 's-c', 3)
  const after = habit.review()
  assert.equal(after.candidates.some((item) => item.status === 'pending'), false)
  assert.equal(after.tombstones.length >= 1, true)
  assert.equal(runtime.refresh().text.includes('prefer tabs'), false)
})

// ---------------------------------------------------------------------------
// 8. lifecycle: protection, expiry and consolidation
// ---------------------------------------------------------------------------

test('P0 and user memory are protected; expiry chain respects protection', async (t) => {
  const harness = createHarness({ config: { lifecycle: { ...DEFAULT_CONFIG.lifecycle, expireDays: 1, dormantDays: 1, weakRecallDays: 1, capacity: 50 } } })
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const { memory } = runtime.require()
  const p0 = memory.write({ title: 'Never delete', body: 'Critical rule.', priority: 'P0', source: 'user' }, 'project', 'user', 's1')
  const expiring = memory.write(
    { title: 'Old task note', body: 'Temporary context.', priority: 'P2', source: 'auto', expiresAt: Date.now() - 1000 },
    'project',
    'agent',
    's1',
  )

  const consolidated = memory.consolidate()
  assert.equal(consolidated.expired >= 1, true)
  assert.equal(memory.findAllCurrent('project').some((entry) => entry.id === expiring.id), false)
  assert.equal(memory.findAllCurrent('project').some((entry) => entry.id === p0.id), true)

  assert.equal(memory.forget(p0.id, 'agent', 'cleanup').ok, false)
  const forced = memory.forget(p0.id, 'user', 'cleanup', true)
  assert.equal(forced.ok, true)
  assert.equal(memory.findAllCurrent('project').some((entry) => entry.id === p0.id), false)

  const health = runtime.health.snapshot()
  assert.ok(['active', 'degraded'].includes(health.status))
})

test('invariant report covers the required guardrails', () => {
  const ids = checkInvariants().map((invariant) => invariant.id)
  for (const required of [
    'roots-separated',
    'cross-layer-blocked',
    'guard-no-echo',
    'index-bounded',
    'recall-bounded',
    'habit-two-gates',
    'habit-cross-session',
    'habit-no-self-promotion',
    'health-visible',
    'zero-llm',
    'p0-protected',
    'audit-hash-chain',
  ]) {
    assert.ok(ids.includes(required), `missing invariant ${required}`)
  }
  assert.equal(checkInvariants().every((invariant) => invariant.ok), true)
  const guardSource = readFileSync(new URL('../src/guard.ts', import.meta.url), 'utf8')
  assert.equal(guardSource.includes('console.log'), false)
})

// ---------------------------------------------------------------------------
// 9. Audit regressions: bounded NDJSON growth and bounded budget bookkeeping
// ---------------------------------------------------------------------------

test('recall-driven appends are compacted so a layer file stays bounded', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const runtime = harness.runtime
  const { memory } = runtime.require()
  const written = memory.write({ title: 'Compaction fact', body: 'compactiontoken repeated recall' }, 'project', 'agent', 's1')
  const entriesFile = join(runtime.projectDir!, 'entries.ndjson')
  const before = readFileSync(entriesFile, 'utf8').trim().split('\n').filter(Boolean).length
  for (let i = 0; i < 400; i++) {
    memory.recall({ sessionId: 's1', query: 'compactiontoken', allowRepeat: true })
  }
  const rows = readFileSync(entriesFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(before, 1)
  // 400 appends without compaction produced 401 rows (~200 KB); with the
  // compaction threshold the file is bounded while the entry survives.
  assert.ok(rows.length < 300, `expected bounded NDJSON, got ${rows.length} rows`)
  assert.equal(memory.findAllCurrent('project').some((entry) => entry.id === written.id), true)
  const fresh = memory.recall({ sessionId: 'compaction-fresh', query: 'compactiontoken' })
  assert.equal(fresh.items.length, 1)
})

test('budget bookkeeping caps tracked sessions instead of growing forever', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  for (let i = 0; i < 600; i++) memory.budgets.session(`budget-session-${i}`)
  assert.equal(memory.budgets.sessionCount, 512)
  assert.equal(memory.budgets.session('budget-session-599').sessionId, 'budget-session-599')
})

test('write-guard covers tags and summary, not just title and body', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  const secret = 'sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv'

  const viaTags = () => memory.write({ title: 'Tag bypass', body: 'benign body', tags: [secret] }, 'project', 'agent', 's1')
  assert.throws(viaTags, (error: unknown) => error instanceof GuardRejection && !error.message.includes(secret))
  const viaSummary = () => memory.write({ title: 'Summary bypass', body: 'benign body', summary: 'password=' + secret }, 'project', 'agent', 's1')
  assert.throws(viaSummary, (error: unknown) => error instanceof GuardRejection && !error.message.includes(secret))

  assert.equal(memory.findAllCurrent('project').length, 0)
})

test('expand cannot exceed the remaining session recall budget', async (t) => {
  const harness = createHarness({ config: { budget: { ...DEFAULT_CONFIG.budget, recallSessionBudgetChars: 260, recallMaxTotalChars: 220, recallMaxResults: 4, recallMaxCharsPerMemory: 120 } } })
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  const written = memory.write({ title: 'Budget fact', body: 'budgettoken ' + 'x'.repeat(900) }, 'project', 'agent', 's1')

  const first = memory.expand(written.id, 's1', 4_000)
  assert.equal(first.found, true)
  assert.ok(first.chars <= 260, `expand respected the session budget (${first.chars})`)

  const again = memory.expand(written.id, 's1', 4_000)
  assert.equal(again.found, true)
  assert.equal(again.chars, 0)
  assert.equal(again.remainingChars, 0)
})

test('habit patterns pass through the write-guard before being persisted', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  const verdict = memory.validateHabitProfile({ id: 'x', status: 'auto', pattern: 'password=hunter2secret', category: 'style', confidence: 0.9, evidenceCount: 1, sessions: ['s1'], pinned: false, createdAt: 0, updatedAt: 0 })
  assert.equal(verdict.ok, false)
  assert.match(String(verdict.detail), /password-assignment/)
  assert.equal(String(verdict.detail).includes('hunter2secret'), false)
})

test('unreadable NDJSON lines are visible as a degraded index and recover when fixed', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  const written = memory.write({ title: 'Survives a bad line', body: 'corrupttoken still readable' }, 'project', 'agent', 's1')

  const projectEntries = join(harness.runtime.projectDir as string, 'entries.ndjson')
  appendFileSync(projectEntries, '{this is not json}\n', 'utf8')

  const degraded = harness.runtime.refresh(true)
  assert.equal(harness.runtime.health.snapshot().status, 'degraded')
  assert.match(harness.runtime.health.warningLine(), /corrupt-layer-lines/)
  assert.ok(degraded.text.includes('corrupt-layer-lines'), 'the injected block carries the warning')

  const recall = memory.recall({ sessionId: 's1', query: 'corrupttoken' })
  assert.equal(recall.items.length, 1, 'readable entries stay recallable')

  writeFileSync(projectEntries, readFileSync(projectEntries, 'utf8').replace('{this is not json}\n', ''), 'utf8')
  const recovered = harness.runtime.refresh(true)
  assert.equal(harness.runtime.health.snapshot().status, 'active')
  assert.equal(recovered.text.includes('corrupt-layer-lines'), false)
})
