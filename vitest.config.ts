/**
 * Optional Vitest config.
 *
 * The committed acceptance suite is plain `node:test` (`pnpm test` ->
 * `node --test tests/`) so the package needs no third-party test runner.
 * Contributors who add Vitest-specific specs can name them `*.vitest.ts`; this
 * config picks them up without touching the node:test suite.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.vitest.ts'],
    environment: 'node',
  },
})
