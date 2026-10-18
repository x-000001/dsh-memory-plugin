#!/usr/bin/env node
/**
 * Package-shape gate. Runs before `pnpm pack` / `pnpm publish` and in CI.
 *
 * It enforces the five pre-publish checks:
 *   1. `"type": "module"` (the Harness loads ESM in-process);
 *   2. `main` and every `exports` target point at `lib/`, never `src/`;
 *   3. `files` is a whitelist that includes the built entry, the Cordis patch
 *      and the license/readme, and excludes sources, tests and local memory;
 *   4. `dsh.bundle.patch` points at an existing patch file (and describes one
 *      loader row);
 *   5. `version` is valid semver.
 *
 * It also scans the shipped sources for credential-looking strings and prints
 * only `file:line` + pattern name (never the matched value).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []
const checks = []

function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) problems.push(`${name}: ${detail}`)
}

// 1. ESM
check('type=module', pkg.type === 'module', `expected "module", got ${JSON.stringify(pkg.type)}`)

// 2. entrypoints under lib/ (metadata subpaths may point at real files)
const METADATA_TARGETS = new Set(['./cordis.patch.yml', './package.json'])
const libTargets = [pkg.main, ...collectTargets(pkg.exports)]
function collectTargets(exportsField) {
  if (!exportsField) return []
  const out = []
  const visit = (value) => {
    if (typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) visit(nested)
  }
  visit(exportsField)
  return out
}
// Every code entrypoint must be build output; ./cordis.patch.yml and
// ./package.json are metadata files the loader/registry may resolve directly.
const badTargets = libTargets.filter(
  (target) => typeof target !== 'string' || (!target.startsWith('./lib/') && !METADATA_TARGETS.has(target)),
)
check('exports->lib', badTargets.length === 0, `targets outside ./lib/: ${badTargets.join(', ')}`)
check('main exists', typeof pkg.main === 'string' && existsSync(join(root, pkg.main)), `missing ${pkg.main}`)

// 3. files whitelist
const files = Array.isArray(pkg.files) ? pkg.files : []
const required = ['lib/', 'cordis.patch.yml', 'README.md', 'LICENSE']
const missingFiles = required.filter((entry) => !files.includes(entry))
check('files whitelist', files.length > 0 && missingFiles.length === 0, `missing entries: ${missingFiles.join(', ')}`)
const forbidden = files.filter((entry) => /^src\//.test(entry) || /^tests\//.test(entry) || /\.dsh/.test(entry))
check('files excludes src/tests/memory', forbidden.length === 0, `forbidden entries: ${forbidden.join(', ')}`)

// 4. Cordis patch
const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
check('dsh.bundle.patch', typeof patch === 'string' && patch.startsWith('./'), `invalid: ${JSON.stringify(patch)}`)
if (typeof patch === 'string') {
  const patchPath = join(root, patch)
  check('patch exists', existsSync(patchPath), `missing ${patch}`)
  if (existsSync(patchPath)) {
    const yml = readFileSync(patchPath, 'utf8')
    const hasInsert = /^\s*-\s*insert:\s*$/m.test(yml)
    const hasRow = /^\s*-\s*id:\s*dsh-memory\b/m.test(yml)
    check('patch has a loader row', hasInsert && hasRow, 'expected one `- insert:` row with id dsh-memory')
    check('patch names this package', yml.includes(`name: ${pkg.name}`), `expected name: ${pkg.name}`)
  }
}

const client = pkg.dsh && pkg.dsh.client
check('dsh.client web', Boolean(client && client.platform === 'web'), 'expected dsh.client.platform = "web"')
check('client entry exists', existsSync(join(root, 'lib', 'client', 'index.js')), 'missing lib/client/index.js (run pnpm build)')

// 5. semver
check('semver version', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version)), `invalid: ${pkg.version}`)

// keywords / metadata expected by the plugin marketplace
check('keywords', Array.isArray(pkg.keywords) && ['dsh-plugin', 'deepseek-harness', 'cordis-plugin'].every((k) => pkg.keywords.includes(k)), 'missing dsh keywords')

// Credential scan over shipped sources (report location + pattern only).
// Tests are excluded on purpose: they contain deliberately fake vectors.
const deny = [
  ['openai-sk-key', /\bsk-[A-Za-z0-9_-]{12,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-pat', /\bghp_[A-Za-z0-9]{20,}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._-]{16,}/],
  ['password-assignment', /\bpassword\s*[:=]\s*["']?[^\s"']{6,}/i],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]
const scanRoots = ['src', 'client', 'scripts'].map((dir) => join(root, dir)).filter(existsSync)
const hits = []
for (const dir of scanRoots) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const [name, pattern] of deny) if (pattern.test(line)) hits.push(`${relative(root, file)}:${index + 1} ${name}`)
    })
  }
}
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile() && /\.(?:ts|js|mjs|cjs)$/.test(entry.name)) out.push(path)
  }
  return out
}
check('no credentials in sources', hits.length === 0, `credential-looking lines (value not printed): ${hits.join(', ')}`)

for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name}${entry.detail && !entry.ok ? ` - ${entry.detail}` : ''}`)
if (problems.length > 0) {
  console.error(`\nverify-package: ${problems.length} problem(s); refusing to pack.`)
  process.exit(1)
}
console.log(`\nverify-package: all ${checks.length} checks passed`)
