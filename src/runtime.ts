/**
 * Runtime wiring: resolve config -> isolated stores -> engine -> habit
 * pipeline -> health. Every failure is captured in the health snapshot and
 * degrades a feature; nothing throws out of construction (a broken store
 * yields `unavailable` + tools that explain why, never a boot failure).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveConfig } from './config.ts'
import { GuardRejection, MemoryEngine } from './memory.ts'
import { LayeredStore } from './storage.ts'
import { HabitEngine } from './habit.ts'
import { HabitJudge, type LlmTextCaller } from './judge.ts'
import { HealthTracker } from './health.ts'
import { buildDisclosure, disclosureSignature, StablePrefix, type DisclosureBlock } from './inject.ts'
import { planIndex } from './budget.ts'
import type { HabitProfile, MemoryEntry, MemoryPluginConfig } from './types.ts'

/** Walk up from cwd looking for a repo marker; null outside a repo. */
export function findProjectRoot(cwd: string): string | null {
  let dir = resolve(cwd)
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.dsh'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function resolveDshHome(explicit?: string): string {
  return explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * `~/.dsh/...` means DSH_HOME (which itself may be relocated); a bare `~`
 * means the OS home. Absolute paths pass through.
 */
export function resolveMemoryPath(path: string, dshHome: string): string {
  if (path.startsWith('~/.dsh/') || path.startsWith('~\\.dsh\\')) return join(dshHome, path.slice('~/.dsh/'.length))
  if (path === '~/.dsh' || path === '~\\.dsh') return dshHome
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return resolve(path)
}

export interface RuntimeOptions {
  cwd: string
  dshHome?: string
  config: Partial<MemoryPluginConfig> | undefined
  now?: () => number
  llmCaller?: LlmTextCaller | null
}

export class MemoryRuntime {
  readonly config: MemoryPluginConfig
  readonly cwd: string
  readonly dshHome: string
  readonly projectRoot: string | null
  /** Absolute <repo>/.dsh/memory (null outside a repo). */
  projectDir: string | null = null
  readonly store: LayeredStore | null
  readonly memory: MemoryEngine | null
  readonly habit: HabitEngine | null
  readonly judge: HabitJudge
  readonly health: HealthTracker
  private readonly prefix = new StablePrefix()
  private warning = ''
  private lastSignature = ''
  private readonly now: () => number

  constructor(options: RuntimeOptions) {
    this.now = options.now ?? Date.now
    this.cwd = options.cwd
    this.dshHome = resolveDshHome(options.dshHome)
    this.config = resolveConfig(options.config)
    this.projectRoot = findProjectRoot(this.cwd)

    const stateFile = join(this.dshHome, 'storages', 'memory', 'health.json')
    this.health = new HealthTracker({ stateFile, now: this.now })
    this.judge = new HabitJudge({
      caller: options.llmCaller ?? null,
      model: this.config.habit.judgeModel,
      timeoutMs: this.config.habit.judgeTimeoutMs,
      enabled: this.config.habit.judgeEnabled,
    })

    let store: LayeredStore | null = null
    try {
      // Project memory must follow the repository at <repo>/.dsh/memory; the
      // global/habit roots live under DSH_HOME and are never merged with it.
      const projectDir = this.projectRoot
        ? isAbsolute(this.config.projectMemoryDir)
          ? this.config.projectMemoryDir
          : join(this.projectRoot, this.config.projectMemoryDir)
        : null
      this.projectDir = projectDir
      store = new LayeredStore({
        projectRoot: projectDir,
        globalRoot: resolveMemoryPath(this.config.globalMemoryDir, this.dshHome),
        habitRoot: resolveMemoryPath(this.config.habitDir, this.dshHome),
        spillRoot: join(this.dshHome, 'storages', 'memory', 'spill'),
        now: this.now,
      })
      this.health.ok('storage')
    } catch (error) {
      this.health.unavailableAll(`memory storage unavailable: ${(error as Error).message}`)
      this.warning = this.health.warningLine()
    }
    this.store = store

    let memory: MemoryEngine | null = null
    let habit: HabitEngine | null = null
    if (store) {
      try {
        memory = new MemoryEngine({
          store,
          config: this.config,
          habitProfiles: () => store?.readHabitProfiles() ?? [],
          now: this.now,
        })
        habit = new HabitEngine({
          store,
          memory,
          settings: this.config.habit,
          judge: this.judge,
          now: this.now,
          onJudgeSuccess: () => this.health.ok('judge'),
          onJudgeFailure: (reason) =>
            this.health.fail('judge', 'judge-failed', `judge call failed (${reason}); fail-open rule mode kept the originals`),
        })
      } catch (error) {
        this.health.fail('recall', 'engine-init-failed', `memory engine failed to initialize: ${(error as Error).message}`)
      }
    }
    this.memory = memory
    this.habit = habit

    this.health.setJudge(
      this.config.habit.judgeEnabled,
      this.judge.enabled,
      'judge model route unavailable; habit judgment falls back to rule mode (fail open)',
    )
    if (this.config.habit.enabled && !habit) {
      this.health.fail('habit', 'habit-engine-unavailable', 'habit learning unavailable: memory engine failed')
    }
    this.warning = this.health.warningLine()
    this.refresh(true)
  }

  get available(): boolean {
    return Boolean(this.store && this.memory)
  }

  require(): { store: LayeredStore; memory: MemoryEngine; habit: HabitEngine } {
    if (!this.store || !this.memory || !this.habit) {
      throw new Error(this.health.warningLine() || 'memory runtime unavailable')
    }
    return { store: this.store, memory: this.memory, habit: this.habit }
  }

  profiles(): HabitProfile[] {
    try {
      return this.store?.readHabitProfiles() ?? []
    } catch {
      return []
    }
  }

  /**
   * Idempotent disclosure: returns the byte-identical block while the content
   * signature is unchanged (this is what keeps prompt cache prefixes stable).
   */
  refresh(force = false): DisclosureBlock {
    if (!this.memory) {
      this.warning = this.health.warningLine()
      return { text: '', hash: '', lines: 0, chars: 0, omitted: 0, tier: 'none', habitLines: 0 }
    }
    const tier = 'full' as const
    let entries: MemoryEntry[] = []
    let signature: string
    try {
      entries = this.memory.findAllCurrent()
      signature = disclosureSignature(entries, this.profiles(), tier, this.warning)
      if (!force && signature === this.lastSignature && this.prefix.current) return this.prefix.current
    } catch (error) {
      signature = `index-error:${(error as Error).message}`
    }
    const failed = signature.startsWith('index-error:')
    let block: DisclosureBlock
    try {
      if (failed) throw new Error(signature.slice('index-error:'.length))
      block = buildDisclosure({ entries, habits: this.profiles(), config: this.config, tier, warning: this.warning })
    } catch (error) {
      // Visible degradation: the warning line itself becomes part of the
      // injected block, so "index broken" cannot be silent.
      this.health.fail('index', 'index-build-failed', `index build failed: ${(error as Error).message}; falling back to one-line index`)
      this.warning = this.health.warningLine()
      signature = `index-error:${(error as Error).message}`
      try {
        const plan = planIndex(entries, this.config.budget, 'single-line')
        block = {
          text: plan.lines.length ? `${this.warning}\n${plan.lines.join('\n')}` : this.warning,
          hash: '',
          lines: plan.lines.length,
          chars: 0,
          omitted: plan.omitted,
          tier: 'single-line',
          habitLines: 0,
        }
      } catch {
        block = { text: this.warning, hash: '', lines: 0, chars: 0, omitted: 0, tier: 'none', habitLines: 0 }
      }
    }
    this.prefix.update(block, signature)
    this.lastSignature = signature
    return block
  }

  /** Append the health warning to the disclosure and make it visible in-session. */
  noteWarning(): void {
    this.warning = this.health.warningLine()
  }

  noteRecallFailure(feature: 'recall' | 'index' | 'write' | 'habit' | 'judge', code: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.health.fail(feature, code, message.slice(0, 240))
    this.noteWarning()
  }

  noteGuardRejection(error: GuardRejection): void {
    // Values are already stripped by guard.describe; report line + pattern only.
    this.health.fail('write', 'write-guard-rejected', error.message.slice(0, 240))
    this.noteWarning()
    this.store?.appendAudit({ type: 'health', actor: 'system', detail: `write degraded: ${error.violations.length} guard violation(s)` })
  }

  noteWriteOk(): void {
    if (!this.health.readHiddenFeature('write')) {
      this.health.ok('write')
      this.noteWarning()
    }
  }

  statusReport(sessionId?: string): Record<string, unknown> {
    const snapshot = this.health.snapshot()
    const warning = this.health.warningLine()
    if (!this.memory) {
      return { ok: false, health: snapshot, warning, config: this.config }
    }
    const report = this.memory.status(sessionId)
    const disclosure = this.refresh()
    return {
      ok: true,
      health: snapshot,
      warning,
      cache: { indexHash: disclosure.hash, prefixStable: this.config.cacheStable, tier: disclosure.tier, lines: disclosure.lines, chars: disclosure.chars },
      stores: report.stores,
      counts: report.counts,
      byStatus: report.byStatus,
      index: report.index,
      habit: report.habit,
      budgets: this.config.budget,
      judge: { enabled: this.judge.enabled, model: this.config.habit.judgeModel },
      zeroLlm: !this.judge.enabled,
    }
  }

  dispose(): void {
    this.prefix.update({ text: '', hash: '', lines: 0, chars: 0, omitted: 0, tier: 'full', habitLines: 0 }, 'disposed')
  }
}
