/**
 * Audit regression probes (phase 2 / phase 3).
 *
 * Each test describes ONE defect found by the read-only analysis phase. A test
 * fails on the pre-fix code and passes after the minimal fix; no test here
 * introduces new features or changes the documented public contract.
 *
 * Engine-level probes import `src` directly (fast, no build required), while
 * public-surface probes load the built `lib/index.js` with a minimal Cordis
 * host Context stand-in, exactly like a real activation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarness } from './harness.ts'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const libEntry = join(repoRoot, 'lib', 'index.js')
const plugin: any = await import(pathToFileURL(libEntry).href)

interface Boot {
  root: string
  dshHome: string
  repoDir: string
  routes: any[]
  tool: (name: string) => any
  cleanup: () => void
}

/**
 * Apply the built plugin once against a fresh tmp DSH_HOME and repository.
 * The runtime anchors its stores at apply() time, so a boot must set
 * `process.env.DSH_HOME` before applying.
 */
function boot(): Boot {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-audit-'))
  const dshHome = join(root, 'dsh-home')
  const repoDir = join(root, 'repo')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  process.env.DSH_HOME = dshHome

  const defs: any[] = []
  const routes: any[] = []
  const disposers: Array<() => void> = []
  const scoped = (extra: Record<string, unknown>) => ({
    effect: (cb: () => unknown) => {
      disposers.push(cb() as () => void)
    },
    ...extra,
  })
  const ctx: any = {
    baseDir: repoDir,
    get: () => null,
    effect: (cb: () => unknown) => {
      disposers.push(cb() as () => void)
    },
    on: () => {},
    inject: (names: string[], callback: any) => {
      if (names.includes('systemPrompt')) {
        callback(
          scoped({
            systemPrompt: {
              section: () => () => {},
            },
          }),
        )
      }
      if (names.includes('webServer')) {
        callback(
          scoped({
            webServer: {
              register: (route: any) => {
                routes.push(route)
                return () => {}
              },
            },
          }),
        )
      }
    },
    tools: {
      register: (definition: any) => {
        defs.push(definition)
        return () => {}
      },
    },
  }
  plugin.apply(ctx, {})

  return {
    root,
    dshHome,
    repoDir,
    routes,
    tool: (name: string) => {
      const found = defs.find((definition) => definition.name === name)
      assert.ok(found, `tool ${name} registered`)
      return found
    },
    cleanup: () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.()
        } catch {
          /* best effort */
        }
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Drive one webserver route with a mock request/response. */
function callRoute(route: any, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const req: any = new EventEmitter()
  req.method = init.method ?? 'GET'
  req.headers = init.headers ?? {}
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(body?: unknown) {
      this.body = String(body ?? '')
    },
  }
  let thrown: unknown = null
  try {
    route.handler(req, res)
    if (init.body !== undefined) {
      req.emit('data', Buffer.from(init.body))
      req.emit('end')
    }
  } catch (error) {
    thrown = error
  }
  return { res, thrown }
}

function route(routes: any[], path: string): any {
  const found = routes.find((candidate) => candidate.path === path)
  assert.ok(found, `route ${path} registered`)
  return found
}

// ---------------------------------------------------------------------------
// BUG-1: memory_expand returned the full body inside `entry` while only the
// truncated `body` was charged to the session budget, so a model could bypass
// the progressive-disclosure budget with memory_expand.
// ---------------------------------------------------------------------------
test('BUG-1 memory_expand payload stays inside the per-call character cap', async (t) => {
  const host = boot()
  t.after(() => host.cleanup())
  const written = await host.tool('memory_remember').execute(
    { title: 'Big fact', content: 'budgettoken ' + 'x'.repeat(900) },
    { agent: { id: 'audit-session' } },
  )
  const expanded = await host.tool('memory_expand').execute(
    { id: written.id, maxChars: 200 },
    { agent: { id: 'audit-session' } },
  )
  assert.equal(expanded.ok, true)
  assert.equal(expanded.entry.body.length, expanded.chars)
  assert.ok(expanded.entry.body.length <= 200, `entry.body length ${expanded.entry.body.length} must stay <= 200`)
})

// ---------------------------------------------------------------------------
// BUG-2: GET /dsh-memory/status threw out of the webserver handler when the
// store could not be read (no try/catch around statusReport), which is an
// uncaught exception in the host process instead of a visible failure.
// ---------------------------------------------------------------------------
test('BUG-2 status route returns a visible 500 instead of throwing when the store is unreadable', async (t) => {
  const host = boot()
  t.after(() => host.cleanup())
  await host.tool('memory_remember').execute({ title: 'Doomed', content: 'doomedtoken' }, { agent: { id: 's1' } })
  const entriesFile = join(host.repoDir, '.dsh', 'memory', 'entries.ndjson')
  unlinkSync(entriesFile)
  mkdirSync(entriesFile) // readFileSync -> EISDIR, an I/O error, not a JSON error

  const { res, thrown } = callRoute(route(host.routes, '/dsh-memory/status'), { method: 'GET' })
  assert.equal(thrown, null, `route must not throw: ${String(thrown)}`)
  // The status read itself is reported as a visible failure: either the route
  // catches it (500) or statusReport() already degraded it (200 + ok:false).
  assert.ok(res.statusCode === 200 || res.statusCode === 500, `status code ${res.statusCode}`)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, false)
  assert.match(String(payload.warning ?? payload.error ?? ''), /status-read-failed|memory root|EISDIR/i)
})

// ---------------------------------------------------------------------------
// BUG-3: POST /dsh-memory/habits threw out of the request 'end' listener when
// the hand-editable candidates.json was malformed.
// ---------------------------------------------------------------------------
test('BUG-3 habits route returns a visible 500 when candidates.json is corrupt', async (t) => {
  const host = boot()
  t.after(() => host.cleanup())
  const habitDir = join(host.dshHome, 'storages', 'habit')
  mkdirSync(habitDir, { recursive: true })
  writeFileSync(join(habitDir, 'candidates.json'), '{ this is not json', 'utf8')

  const { res, thrown } = callRoute(route(host.routes, '/dsh-memory/habits'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://${'127.0.0.1:3084'}`, host: '127.0.0.1:3084' },
    body: JSON.stringify({ action: 'list' }),
  })
  assert.equal(thrown, null, `route must not throw: ${String(thrown)}`)
  assert.equal(res.statusCode, 500)
  assert.equal(JSON.parse(res.body).ok, false)
})

// ---------------------------------------------------------------------------
// BUG-4: memory_status threw a rejected tool promise when the store could not
// be read; the contract is that failures are visible as ok:false + warning.
// ---------------------------------------------------------------------------
test('BUG-4 memory_status reports a visible failure instead of throwing', async (t) => {
  const host = boot()
  t.after(() => host.cleanup())
  await host.tool('memory_remember').execute({ title: 'Doomed status', content: 'doomed status token' }, { agent: { id: 's1' } })
  const entriesFile = join(host.repoDir, '.dsh', 'memory', 'entries.ndjson')
  unlinkSync(entriesFile)
  mkdirSync(entriesFile)

  const result = await host.tool('memory_status').execute({}, { agent: { id: 's1' } })
  assert.equal(result.ok, false)
  assert.ok(typeof result.warning === 'string' && result.warning.length > 0)
})

// ---------------------------------------------------------------------------
// BUG-5: consolidate() assigned report.kept inside the per-layer loop, so the
// returned kept count only reflected the last layer instead of the whole run.
// ---------------------------------------------------------------------------
test('BUG-5 consolidate reports kept entries across every layer', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  memory.write({ title: 'Project kept', body: 'project kept token' }, 'project', 'agent', 's1')
  memory.write({ title: 'Global kept', body: 'global kept token' }, 'global', 'agent', 's1')
  const report = memory.consolidate()
  assert.equal(report.kept, 2)
  assert.equal(memory.findAllCurrent().length, 2)
})

// ---------------------------------------------------------------------------
// BUG-6: resolveConfig replaced a configured budget.degradeOrder with the
// default, so the documented degradation order was not configurable.
// ---------------------------------------------------------------------------
test('BUG-6 configured budget.degradeOrder is honored', () => {
  const configured = resolveConfig({
    budget: { ...DEFAULT_CONFIG.budget, degradeOrder: ['minimal', 'compact', 'single-line', 'none'] },
  })
  assert.deepEqual(configured.budget.degradeOrder, ['minimal', 'compact', 'single-line', 'none'])
  const defaulted = resolveConfig(undefined)
  assert.deepEqual(defaulted.budget.degradeOrder, DEFAULT_CONFIG.budget.degradeOrder)
})

// ---------------------------------------------------------------------------
// BUG-7: findCurrent kept the FIRST row of a version while findAllCurrent keeps
// the LAST, so bumpRecall always re-read the pre-recall row: recallCount never
// grew past 1, and capacity eviction sorted on stale counts.
// ---------------------------------------------------------------------------
test('BUG-7 repeated recall accumulates recallCount on the visible entry', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  const written = memory.write({ title: 'Recall counter', body: 'recallcounttoken' }, 'project', 'agent', 's1')
  memory.recall({ sessionId: 's1', query: 'recallcounttoken', allowRepeat: true })
  memory.recall({ sessionId: 's1', query: 'recallcounttoken', allowRepeat: true })
  const entry = memory.findAllCurrent('project').find((candidate) => candidate.id === written.id)
  assert.ok(entry)
  assert.equal(entry.recallCount, 2)
})

// ---------------------------------------------------------------------------
// BUG-8: the dedupe lookup matched archived revisions, so re-writing content
// that had been superseded returned the archived version as "deduped" even
// though that content was no longer visible (recall/expand ignore archived),
// permanently losing the re-written content.
// ---------------------------------------------------------------------------
test('BUG-8 re-writing superseded content is stored as a new visible version', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  memory.write({ title: 'Versioned fact', body: 'alpha content' }, 'project', 'agent', 's1')
  memory.write({ title: 'Versioned fact', body: 'beta content' }, 'project', 'agent', 's1')
  const again = memory.write({ title: 'Versioned fact', body: 'alpha content' }, 'project', 'agent', 's1')
  assert.equal(again.deduped, false)
  assert.equal(again.version, 3)
  const visible = memory.findAllCurrent('project').find((candidate) => candidate.id === again.id)
  assert.ok(visible)
  assert.equal(visible.body, 'alpha content')
})

// ---------------------------------------------------------------------------
// Passing probes: these guard behaviour the audit verified as correct.
// ---------------------------------------------------------------------------
test('PROBE custom index budget is honored and refresh stays byte-stable', async (t) => {
  const harness = createHarness({
    config: { budget: { ...DEFAULT_CONFIG.budget, indexMaxLines: 1, indexMaxChars: 200 } },
  })
  t.after(() => harness.cleanup())
  const { memory } = harness.runtime.require()
  memory.write({ title: 'First', body: 'firsttoken' }, 'project', 'agent', 's1')
  memory.write({ title: 'Second', body: 'secondtoken' }, 'project', 'agent', 's1')
  const first = harness.runtime.refresh(true)
  assert.ok(first.lines <= 1, `index lines ${first.lines}`)
  const second = harness.runtime.refresh()
  assert.equal(first.text, second.text)
})

test('PROBE audit chain verifies after many writes and dispose is idempotent', async (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const { memory, store } = harness.runtime.require()
  for (let index = 0; index < 20; index += 1) {
    memory.write({ title: `Filler ${index}`, body: `fillertoken ${index}` }, 'project', 'agent', 's1')
  }
  assert.equal(store.verifyAuditChain(), null)
  harness.runtime.dispose()
  harness.runtime.dispose()
})
