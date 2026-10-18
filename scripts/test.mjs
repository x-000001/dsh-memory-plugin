#!/usr/bin/env node
/**
 * Zero-dependency test launcher.
 *
 * `node --test tests/` is the canonical command, but Node's test runner spawns
 * one child process per test file and captures stdout through a pipe. Hosted
 * agent sandboxes (and some locked-down Windows environments) deny that spawn
 * with EPERM even though the tests themselves are fine. This launcher discovers
 * the same `*.spec.ts` files and executes each one directly with the runtime's
 * own TypeScript type stripping, inheriting stdio. It is what `pnpm test` runs
 * locally and in CI; the tests themselves are plain `node:test`.
 *
 * Deterministic discovery: files are sorted, directories walked recursively.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = join(root, 'tests')

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.spec.ts') || name.endsWith('.test.ts')) out.push(full)
  }
}

const files = []
walk(testsDir, files)
if (files.length === 0) {
  console.error('[test] no *.spec.ts files found under tests/')
  process.exit(1)
}

let failed = 0
for (const file of files) {
  const label = relative(root, file)
  console.log(`[test] ${label}`)
  const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`[test] failed to launch ${label}: ${result.error.message}`)
    failed += 1
  } else if ((result.status ?? 1) !== 0) {
    failed += 1
  }
}

console.log(`[test] ${files.length - failed}/${files.length} test file(s) passed`)
process.exit(failed === 0 ? 0 : 1)
