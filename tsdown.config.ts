/**
 * Optional bundler config.
 *
 * The supported build is `node scripts/build.mjs` (zero dependencies: Node's own
 * TypeScript type stripper), which is what `pnpm build` runs and what CI runs.
 * This tsdown config is kept for contributors who want a single-file bundle or
 * `.d.ts` emit; it is not required by the release path.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: false,
  sourcemap: false,
})
