import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const libEntry = join(repoRoot, 'lib', 'index.js')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-lib-'))
const dshHome = join(root, 'dsh-home')
const repoDir = join(root, 'repo')
mkdirSync(join(repoDir, '.git'), { recursive: true })
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = dshHome

const entry: any = await import(pathToFileURL(libEntry).href)

/** Minimal Cordis host Context stand-in: only the APIs this plugin uses. */
const defs: any[] = []
const sections: any[] = []
const routes: any[] = []
const disposers: Array<() => void> = []
const handlers: Record<string, any[]> = {}
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
  on: (event: string, handler: any) => {
    ;(handlers[event] ??= []).push(handler)
  },
  inject: (names: string[], callback: any) => {
    if (names.includes('systemPrompt')) {
      callback(
        scoped({
          systemPrompt: {
            section: (options: any) => {
              sections.push(options)
              return () => {}
            },
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

test.after(() => {
  for (const dispose of disposers.reverse()) {
    try {
      dispose?.()
    } catch {
      /* cleanup best effort */
    }
  }
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(root, { recursive: true, force: true })
})

function tool(name: string): any {
  const found = defs.find((definition) => definition.name === name)
  assert.ok(found, `tool ${name} registered`)
  return found
}

const exec = { session: { id: 'lib-session' }, signal: undefined }

test('built host half loads with zero third-party imports', () => {
  assert.equal(entry.name, 'dsh-memory')
  assert.ok(entry.inject.includes('tools'))
  assert.equal(typeof entry.apply, 'function')

  // Static import specifiers, line-anchored so prose inside string literals is
  // not mistaken for an import. Anything bare (not node:/relative) would mean
  // the published artifact depends on a module the plugin directory cannot
  // resolve at activation time.
  const bare: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.js')) continue
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const match = /^\s*(?:import|export)\b.*?\bfrom\s+['"]([^'"]+)['"]/.exec(line)
        const sideEffect = /^\s*import\s+['"]([^'"]+)['"]/.exec(line)
        const specifier = match?.[1] ?? sideEffect?.[1]
        if (!specifier) continue
        if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:')) continue
        bare.push(`${full}: ${specifier}`)
      }
    }
  }
  walk(join(repoRoot, 'lib'))
  assert.deepEqual(bare, [], 'lib/ must only import node: builtins and relative modules')
})

test('apply() registers the full memory tool table', () => {
  entry.apply(ctx, {})
  const names = defs.map((definition) => definition.name).sort()
  assert.deepEqual(names, [
    'memory_consolidate',
    'memory_expand',
    'memory_feedback',
    'memory_forget',
    'memory_habits',
    'memory_recall',
    'memory_remember',
    'memory_status',
  ])
  for (const definition of defs) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20, `${definition.name} has a usable description`)
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.schema, 'object')
  }
})

test('tool schemas use only the JSON Schema subset the harness accepts', () => {
  // Regression: dsh-tools rejects `type: "json"` on the wire ("schema.type
  // must be one of object/array/string/number/integer/boolean/null"); the
  // author-only `json` spec must compile to the annotation-only form.
  const allowed = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  const walk = (node: any, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`))
      return
    }
    if (!node || typeof node !== 'object') return
    if (Object.hasOwn(node, 'type')) {
      assert.ok(typeof node.type === 'string', `${path}.type is a string`)
      assert.ok(allowed.has(node.type), `${path}.type "${node.type}" is a supported JSON Schema type`)
    }
    for (const key of ['properties']) {
      if (node[key]) for (const [name, child] of Object.entries(node[key])) walk(child, `${path}.${key}.${name}`)
    }
    for (const key of ['items', 'additionalProperties']) {
      if (node[key]) walk(node[key], `${path}.${key}`)
    }
    for (const key of ['oneOf', 'anyOf']) {
      if (Array.isArray(node[key])) walk(node[key], `${path}.${key}`)
    }
  }
  for (const definition of defs) {
    walk(definition.parameters, `${definition.name}.parameters`)
    walk(definition.output.schema, `${definition.name}.output.schema`)
  }
})

test('memory_habits is read-only: the model cannot promote a habit', () => {
  const habits = tool('memory_habits')
  const properties = habits.parameters?.properties ?? {}
  assert.deepEqual(Object.keys(properties), [], 'no model-callable mutation parameters')
  assert.match(habits.description, /human|read-only/i)
  assert.doesNotMatch(JSON.stringify(properties), /promote|confirm|action/)
})

test('remember -> recall works with no llm service (zero-LLM core)', async () => {
  const remembered = await tool('memory_remember').execute(
    { title: 'tabs', content: 'Indent with tabs, never spaces.', tags: ['style'] },
    exec,
  )
  assert.equal(remembered.ok, true)
  assert.equal(remembered.version, 1)

  const recalled = await tool('memory_recall').execute({ query: 'indentation tabs style' }, exec)
  assert.equal(Array.isArray(recalled.items), true)
  assert.equal(recalled.items.length, 1)
  assert.equal(recalled.items[0].title, 'tabs')
  assert.equal(typeof recalled.items[0].excerpt, 'string')
  assert.ok(recalled.spentChars > 0)
  assert.ok(recalled.tier)
})

test('resident index section is registered once and renders byte-identically', () => {
  const section = sections.find((candidate) => candidate.name === 'dsh-memory')
  assert.ok(section, 'systemPrompt section registered')
  assert.equal(typeof section.text, 'function')
  const first = section.text()
  const second = section.text()
  assert.equal(first, second, 'stable prefix: same content => identical bytes')
  assert.match(first, /Memory index/)
  assert.equal(sections.length, 1)
})

test('status tool reports active health and the four stores after zero-LLM work', async () => {
  const status = await tool('memory_status').execute({ verbose: true }, exec)
  assert.equal(status.ok, true)
  assert.equal(status.health.status, 'active')
  assert.equal(status.zeroLlm, true)
  assert.ok(status.stores.project)
  assert.ok(status.stores.global)
  assert.ok(status.stores.habit)
  assert.equal(status.judge.enabled, false)
})

test('HTTP surface is optional but registered when webServer exists', () => {
  const paths = routes.map((route) => route.path)
  assert.deepEqual(paths.sort(), ['/dsh-memory/habits', '/dsh-memory/status'])
  assert.equal(typeof handlers['session/event'], 'object')
})

test('package.json passes the five pre-publish checks', () => {
  // exports/main point at lib/ build output, never src/
  assert.equal(pkg.type, 'module')
  assert.match(pkg.main, /^\.\/lib\//)
  assert.match(pkg.exports['.'], /^\.\/lib\//)
  // files whitelist includes the entry and the patch
  assert.ok(pkg.files.includes('lib/'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  // dsh.bundle.patch points at the patch file
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  // semver version
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  // client half export + patch present on disk
  assert.equal(pkg.exports['./client'], './lib/client/index.js')
  assert.ok(statSync(join(repoRoot, 'cordis.patch.yml')).isFile())
  assert.ok(statSync(join(repoRoot, 'lib', 'client', 'index.js')).isFile())
})

test('client half registers a settings.section and uses the module loader', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'client', 'index.js'), 'utf8')
  assert.match(source, /__ModuleLoader__/)
  assert.match(source, /settings\.section/)
  assert.match(source, /dsh-memory/)
  assert.doesNotMatch(source, /document\.body\.append/)
})

test('tarball inputs exclude src/, tests/ and local .dsh/memory', () => {
  // The `files` whitelist is what npm/pnpm pack use; verify nothing outside it
  // can leak into the published artifact.
  assert.equal(pkg.files.includes('src/'), false)
  assert.equal(pkg.files.includes('tests/'), false)
  assert.equal(pkg.files.includes('.dsh/memory'), false)
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
  assert.match(gitignore, /\.dsh\/memory\//)
  assert.match(gitignore, /node_modules\//)
})

// ---------------------------------------------------------------------------
// Audit regressions: real DSH execution/session contracts and HTTP hardening
// ---------------------------------------------------------------------------

test('tool executions are isolated by exec.agent.id (the real SessionId)', async () => {
  const execA = { agent: { id: 'agent-session-a' }, signal: undefined }
  const execB = { agent: { id: 'agent-session-b' }, signal: undefined }
  const written = await tool('memory_remember').execute({ title: 'Session scoped', content: 'isolationtoken only here' }, execA)
  assert.equal(written.ok, true)

  const a = await tool('memory_recall').execute({ query: 'isolationtoken' }, execA)
  assert.equal(a.items.length, 1)
  // A DIFFERENT session must not be deduped by A's disclosure and must get its
  // own recall budget bucket. Before the fix both collapsed into 'unsessioned'
  // and B saw items:0 / deduped:1.
  const b = await tool('memory_recall').execute({ query: 'isolationtoken' }, execB)
  assert.equal(b.items.length, 1)
  assert.equal(b.dedupedIds.length, 0)
})

test('habit observation reads the real SessionEvent envelope (event.data)', async () => {
  const signalsFile = join(dshHome, 'storages', 'habit', 'signals.ndjson')
  const envelope = (text: string) => ({ type: 'user/message', seq: 1, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
  const correction = '\u4e0d\u5bf9\uff0c\u5e94\u8be5\u7528 tabs\u3002'
  const eventHandlers: Array<(session: any, event: any) => void> = handlers['session/event'] ?? []
  assert.ok(eventHandlers.length >= 1, 'session/event is observed')
  // Every listener must see the event: one anchors the project layer, another
  // feeds deterministic habit observation.
  const dispatch = (session: any, event: any) => {
    for (const eventHandler of eventHandlers) eventHandler(session, event)
  }
  for (let i = 0; i < 3; i++) dispatch({ id: 'habit-envelope-session' }, envelope(correction))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const lines = readFileSync(signalsFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.ok(lines.length >= 3, `expected >=3 habit signals, got ${lines.length}`)

  // Plugin-sourced user-role messages must not train habits.
  const before = lines.length
  dispatch({ id: 'habit-envelope-session' }, { ...envelope(correction), data: { role: 'user', content: [{ type: 'text', text: correction }], source: { kind: 'system-prompt' } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const after = readFileSync(signalsFile, 'utf8').trim().split('\n').filter(Boolean).length
  assert.equal(after, before)
})

test('the model can neither mint P0 nor force-forget user-protected memory', async () => {
  const forget = tool('memory_forget')
  assert.equal('force' in forget.parameters, false, 'force must not be a model-facing parameter')

  const p0 = await tool('memory_remember').execute({ title: 'P0 rule', content: 'never forget this', priority: 'P0' }, exec)
  assert.equal(p0.ok, false)
  assert.match(String(p0.error), /P0 is reserved for user-authored rules/)

  const normal = await tool('memory_remember').execute({ title: 'model note', content: 'fortoken ordinary note' }, exec)
  assert.equal(normal.ok, true)
  const removed = await forget.execute({ id: normal.id, reason: 'agent wants it gone', force: true }, exec)
  assert.equal(removed.ok, true, 'P2 memory can still be forgotten')
  const recalled = await tool('memory_recall').execute({ query: 'fortoken' }, exec)
  assert.equal(recalled.items.some((item: any) => item.id === normal.id), false)
})

function callRoute(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: any }> {
  const route = routes.find((candidate) => candidate.path === path)
  assert.ok(route, `route ${path} registered`)
  const req: any = new EventEmitter()
  req.method = options.method ?? 'GET'
  req.headers = { host: '127.0.0.1:3084', ...(options.headers ?? {}) }
  let status = 0
  let raw = ''
  const done = new Promise<{ status: number; body: any }>((resolve) => {
    const res: any = {
      writeHead: (code: number) => {
        status = code
        return res
      },
      end: (chunk?: any) => {
        raw += chunk === undefined ? '' : String(chunk)
        resolve({ status, body: (() => { try { return JSON.parse(raw) } catch { return raw } })() })
      },
    }
    route.handler(req, res)
    if (options.body !== undefined) req.emit('data', Buffer.from(options.body))
    req.emit('end')
  })
  return done
}

test('habit mutation HTTP surface only accepts same-origin JSON POSTs', async () => {
  const base = { 'content-type': 'application/json', origin: 'http://127.0.0.1:3084' }

  const getRejected = await callRoute('/dsh-memory/habits', { method: 'GET' })
  assert.equal(getRejected.status, 405)

  const textPlain = await callRoute('/dsh-memory/habits', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"list"}' })
  assert.equal(textPlain.status, 415)

  const crossSite = await callRoute('/dsh-memory/habits', { method: 'POST', headers: { ...base, origin: 'https://evil.example' }, body: '{"action":"list"}' })
  assert.equal(crossSite.status, 403)

  const tooBig = await callRoute('/dsh-memory/habits', { method: 'POST', headers: base, body: 'x'.repeat(40 * 1024) })
  assert.equal(tooBig.status, 413)

  const list = await callRoute('/dsh-memory/habits', { method: 'POST', headers: base, body: '{"action":"list"}' })
  assert.equal(list.status, 200)
  assert.equal(list.body.ok, true)

  const statusPost = await callRoute('/dsh-memory/status', { method: 'POST' })
  assert.equal(statusPost.status, 405)
})
