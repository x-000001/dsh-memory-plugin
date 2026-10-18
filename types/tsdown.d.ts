/**
 * Local type shim for the OPTIONAL bundler config (`tsdown.config.ts`).
 *
 * tsdown is intentionally not a package dependency (the supported build is the
 * zero-dependency `scripts/build.mjs`), so it is not installed for this repo.
 * Declaring the one API the optional config uses keeps `tsc --noEmit` green
 * without adding a dependency or dropping the tsdown config from the repo.
 */
declare module 'tsdown' {
  export interface TsdownConfig {
    entry?: string | string[]
    format?: string | string[]
    platform?: string
    target?: string | string[]
    dts?: boolean
    clean?: boolean
    sourcemap?: boolean
    [key: string]: unknown
  }
  export function defineConfig<T extends TsdownConfig>(config: T): T
}
