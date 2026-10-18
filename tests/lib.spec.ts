import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
