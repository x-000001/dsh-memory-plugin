#!/usr/bin/env node
/**
 * Zero-dependency build.
 *
 * The plugin intentionally has no runtime and no build-time third-party
 * dependencies: `dsh` must be able to load it offline, and contributors must be
 * able to rebuild it with nothing but Node. We therefore use the runtime's own
 * TypeScript type stripper (`node:module.stripTypeScriptTypes`) to emit
 * `lib/*.js` from `src/*.ts`, then rewrite relative `.ts` specifiers to `.js`
 * (Node ESM requires explicit extensions).
 *
 * `node scripts/build.mjs --check` does not write: it fails when the committed
 * `lib/` output is stale relative to `src/`, which is what CI runs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const check = process.argv.includes('--check')

const imports = /(\bfrom\s*['"])(\.{1,2}\/[^'"]*?)\.ts(['"])/g
const dynamicImports = /(\bimport\(\s*['"])(\.{1,2}\/[^'"]*?)\.ts(['"]\s*\))/g

function rewriteSpecifiers(code) {
  return code.replace(imports, '$1$2.js$3').replace(dynamicImports, '$1$2.js$3')
}

function transpile(source, file) {
  let stripped
  try {
    stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
  } catch (error) {
    throw new Error(`failed to strip types from ${file}: ${error instanceof Error ? error.message : error}`)
  }
  // `strip` keeps comments and formatting, which keeps the diff readable.
  return rewriteSpecifiers(stripped)
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

const srcDir = join(root, 'src')
const outDir = join(root, 'lib')
const files = walk(srcDir)
if (files.length === 0) {
  console.error('build: no TypeScript sources found under src/')
  process.exit(1)
}

const stale = []
const written = []
for (const file of files) {
  const rel = relative(srcDir, file).split(sep).join('/')
  const target = join(outDir, rel.replace(/\.ts$/, '.js'))
  const output = transpile(readFileSync(file, 'utf8'), rel)
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== output) stale.push(relative(root, target))
  } else {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, output)
    written.push(relative(root, target))
  }
}

// The client half is authored as plain ESM-in-RequireJS-shape JavaScript; it is
// copied verbatim (no transpile step, no bundler).
const clientSrc = join(root, 'client', 'index.js')
const clientOut = join(outDir, 'client', 'index.js')
if (existsSync(clientSrc)) {
  const output = readFileSync(clientSrc, 'utf8')
  if (check) {
    if (!existsSync(clientOut) || readFileSync(clientOut, 'utf8') !== output) stale.push(relative(root, clientOut))
  } else {
    mkdirSync(dirname(clientOut), { recursive: true })
    writeFileSync(clientOut, output)
    written.push(relative(root, clientOut))
  }
}

if (check) {
  if (stale.length > 0) {
    console.error('build: committed lib/ is stale, run `pnpm build` and commit the result:')
    for (const file of stale) console.error(`  - ${file}`)
    process.exit(1)
  }
  console.log(`build: lib/ is up to date (${files.length} modules)`)
} else {
  console.log(`build: wrote ${written.length} file(s) to lib/`)
}
