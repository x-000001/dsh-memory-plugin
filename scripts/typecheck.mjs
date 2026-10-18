#!/usr/bin/env node
/**
 * Optional-but-preferred type checking.
 *
 * The published package is dependency-free on purpose, so `tsc` is not a
 * dependency. This script uses a TypeScript compiler when one is reachable
 * (local node_modules, the dev workspace two levels up, `TSC` env var, or a
 * global `tsc`) and otherwise falls back to a *visible*, non-silent check:
 * every `src/**\/*.ts` must parse through Node's type stripper. The fallback
 * never pretends to be a full type check - it prints exactly what it did.
 *
 * CI installs TypeScript globally before calling this script, so the release
 * gate always performs the real `tsc --noEmit` check.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

function findCompiler() {
  const candidates = [
    process.env.TSC,
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    join(root, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }

  // A globally installed tsc (npm i -g typescript, or the CI setup step).
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tsc'], { encoding: 'utf8' })
  const first = String(probe.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line))
  return first ?? null
}

const compiler = findCompiler()
if (compiler) {
  console.log(`typecheck: using ${compiler}`)
  const result = spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json'), '--noEmit'], {
    stdio: 'inherit',
    cwd: root,
  })
  process.exit(result.status ?? 1)
}

const files = walk(join(root, 'src')).concat(walk(join(root, 'tests')))
console.warn('typecheck: no TypeScript compiler found - running parse-level fallback')
console.warn('typecheck: this is NOT a full type check; run `pnpm add -D typescript && pnpm typecheck` for one')
let failed = 0
for (const file of files) {
  const rel = file.slice(root.length + 1)
  try {
    stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip', sourceUrl: rel })
  } catch (error) {
    failed += 1
    console.error(`typecheck: ${rel} failed to parse: ${error instanceof Error ? error.message : error}`)
  }
}
if (failed > 0) {
  console.error(`typecheck: ${failed} file(s) failed to parse`)
  process.exit(1)
}
console.log(`typecheck: parsed ${files.length} TypeScript file(s) (fallback mode)`)
