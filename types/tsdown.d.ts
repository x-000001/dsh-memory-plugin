/**
 * Local type shim for the OPTIONAL bundler config (`tsdown.config.ts`).
 *
 * tsdown is not a dependency of this package (the supported build is the
 * zero-dependency `scripts/build.mjs`), and this environment has no registry
 * access, so the module is not installed here. Declaring the one API the
 * optional config uses keeps `tsc --noEmit` green without adding a dependency
 * or dropping the tsdown config from the repo.
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
