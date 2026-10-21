/**
 * v6' acceptance regressions (T0 root causes).
 *
 * T0 failed because the Cordis process starts in `~` (or the install
 * directory), whose `.dsh` is DSH_HOME: the project store was placed inside
 * the global store root, LayeredStore rejected the alias and the whole
 * runtime went `unavailable`. These tests pin the three fixes:
 *
 *  1. project-root detection never treats a DSH_HOME `.dsh` as a repo marker;
 *  2. a project/global root conflict drops only the project layer (global and
 *     habit memory stay usable, the concrete reason stays visible), and a real
 *     session workspace can anchor the project layer lazily;
 *  3. `memory_status` returns lossless JSON when the runtime is unavailable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarness } from './harness.ts'
import { findProjectRoot, MemoryRuntime } from '../src/runtime.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const libEntry = join(repoRoot, 'lib', 'index.js')
const plugin: any = await import(pathToFileURL(libEntry).href)

test('findProjectRoot ignores a DSH_HOME `.dsh` marker but honors a repo `.dsh`', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const homeLike = join(root, 'home')
  const dshHome = join(homeLike, '.dsh')
  mkdirSync(dshHome, { recursive: true })

  // Process started in `~`: `<home>/.dsh` IS DSH_HOME, so it is not a project.
  assert.equal(findProjectRoot(homeLike, dshHome), null)

  // A repository below the home directory is still detected through `.git`.
  const repo = join(homeLike, 'work', 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  assert.equal(findProjectRoot(repo, dshHome), repo)

  // `<dir>/.dsh` remains a valid marker when it is not DSH_HOME.
  const marked = join(root, 'marked')
  mkdirSync(join(marked, '.dsh'), { recursive: true })
  assert.equal(findProjectRoot(marked, dshHome), marked)
})

test('a home-like process cwd degrades only the project layer, not the runtime', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-home-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const homeLike = join(root, 'home')
  const dshHome = join(homeLike, '.dsh')
  mkdirSync(dshHome, { recursive: true })

  const runtime = new MemoryRuntime({ cwd: homeLike, dshHome, config: {} })
  t.after(() => runtime.dispose())

  assert.equal(runtime.projectRoot, null)
  assert.equal(runtime.projectDir, null)
  assert.equal(runtime.available, true, 'global + habit memory stay available')
  const snapshot = runtime.health.snapshot()
  assert.equal(snapshot.status, 'degraded')
  assert.ok(snapshot.reasons.some((reason) => reason.code === 'project-layer-unavailable'))
  assert.match(runtime.health.warningLine(), /project-layer-unavailable/)

  const { memory } = runtime.require()
  const written = memory.write({ title: 'Global survives', body: 'global survives token' }, 'global', 'user', 's1')
  assert.equal(written.deduped, false)
  assert.equal(memory.findCurrent('global', written.id)?.title, 'Global survives')
})

test('a session workspace anchors the project layer exactly once', (t) => {
  const harness = createHarness()
  t.after(() => harness.cleanup())
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-anchor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const runtime = new MemoryRuntime({ cwd: root, dshHome, config: {} })
  t.after(() => runtime.dispose())
  assert.equal(runtime.projectRoot, null)

  assert.equal(runtime.anchor(harness.projectA), true)
  assert.equal(runtime.projectRoot, harness.projectA)
  assert.equal(runtime.projectDir, join(harness.projectA, '.dsh', 'memory'))
  assert.equal(runtime.health.snapshot().status, 'active')

  const { memory } = runtime.require()
  const written = memory.write({ title: 'Anchored project', body: 'anchored project token' }, 'project', 'agent', 's1')
  assert.equal(written.deduped, false)
  assert.equal(memory.findCurrent('project', written.id)?.title, 'Anchored project')

  // The project store is bound once per process (documented limitation).
  assert.equal(runtime.anchor(harness.projectB), false)
  assert.equal(runtime.projectRoot, harness.projectA)
})

test('memory_status summary is lossless JSON when the runtime is unavailable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-status-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const repoDir = join(root, 'repo')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  // A file where the habit root must be a directory makes LayeredStore fail
  // and drives the runtime to `unavailable` with a visible reason.
  writeFileSync(join(dshHome, 'storages', 'habit'), 'not a directory', 'utf8')
  process.env.DSH_HOME = dshHome

  const defs: any[] = []
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
        callback(scoped({ systemPrompt: { section: () => () => {} } }))
      }
      if (names.includes('webServer')) {
        callback(scoped({ webServer: { register: () => () => {} } }))
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
  t.after(() => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        /* best effort */
      }
    }
  })

  const status = defs.find((definition) => definition.name === 'memory_status')
  assert.ok(status, 'memory_status registered')
  const value = await status.execute({}, { agent: { id: 's1' } })

  assert.equal(value.ok, false)
  assert.ok(typeof value.warning === 'string' && value.warning.length > 0)
  // No `undefined` fields: the JSON that reaches the model must be valid.
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.equal(roundTripped.ok, false)
  assert.ok(typeof roundTripped.health === 'object' && roundTripped.health !== null)
  assert.equal(Object.values(roundTripped).includes(undefined), false)
})
