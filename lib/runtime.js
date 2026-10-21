/**
 * Runtime wiring: resolve config -> isolated stores -> engine -> habit
 * pipeline -> health. Every failure is captured in the health snapshot and
 * degrades a feature; nothing throws out of construction (a broken store
 * yields `unavailable` + tools that explain why, never a boot failure).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveConfig } from './config.js'
import { GuardRejection, MemoryEngine } from './memory.js'
import { LayeredStore } from './storage.js'
import { HabitEngine } from './habit.js'
import { HabitJudge,                    } from './judge.js'
import { HealthTracker } from './health.js'
import { buildDisclosure, disclosureSignature, StablePrefix,                      } from './inject.js'
import { planIndex } from './budget.js'
                                                                               

/**
 * True when a `.dsh` directory looks like a DSH home (it holds DSH's own
 * profiles/storages/cordis.yml) rather than a project memory folder.
 */
function looksLikeDshHome(marker        )          {
  return (
    existsSync(join(marker, 'profiles')) ||
    existsSync(join(marker, 'storages')) ||
    existsSync(join(marker, 'cordis.yml'))
  )
}

/** Walk up from cwd looking for a repo marker; null outside a repo. */
export function findProjectRoot(cwd        , dshHome         )                {
  const home = resolve(dshHome ?? resolveDshHome())
  let dir = resolve(cwd)
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir
    const marker = join(dir, '.dsh')
    // `.dsh` is a project marker only when it is neither DSH_HOME itself nor
    // another DSH home. A process started in `~` must not claim the home
    // directory as the project root: its `.dsh` holds global/habit memory, and
    // putting the project store inside it would alias the global root (a
    // cross-layer write). Real repositories are found through `.git`.
    if (existsSync(marker) && resolve(marker) !== home && !looksLikeDshHome(marker)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function resolveDshHome(explicit         )         {
  return explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * `~/.dsh/...` means DSH_HOME (which itself may be relocated); a bare `~`
 * means the OS home. Absolute paths pass through.
 */
export function resolveMemoryPath(path        , dshHome        )         {
  if (path.startsWith('~/.dsh/') || path.startsWith('~\\.dsh\\')) return join(dshHome, path.slice('~/.dsh/'.length))
  if (path === '~/.dsh' || path === '~\\.dsh') return dshHome
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return resolve(path)
}

                                 
             
                  
                                                 
                    
                                  
 

export class MemoryRuntime {
           config                    
           cwd        
           dshHome        
  projectRoot               
  /** Absolute <repo>/.dsh/memory (null outside a repo / before anchoring). */
  projectDir                = null
  store                      = null
  memory                      = null
  habit                     = null
           judge            
           health               
                   prefix = new StablePrefix()
          warning = ''
          lastSignature = ''
                   now              
  /** Concrete error when only the project layer had to be dropped. */
          projectLayerError                = null
  /** True once the project layer is bound to a real repository. */
          anchored = false

  constructor(options                ) {
    this.now = options.now ?? Date.now
    this.cwd = options.cwd
    this.dshHome = resolveDshHome(options.dshHome)
    this.config = resolveConfig(options.config)
    this.projectRoot = findProjectRoot(this.cwd, this.dshHome)
    this.projectDir = this.projectRoot ? this.projectDirFor(this.projectRoot) : null

    const stateFile = join(this.dshHome, 'storages', 'memory', 'health.json')
    this.health = new HealthTracker({ stateFile, now: this.now })
    this.judge = new HabitJudge({
      caller: options.llmCaller ?? null,
      model: this.config.habit.judgeModel,
      timeoutMs: this.config.habit.judgeTimeoutMs,
      enabled: this.config.habit.judgeEnabled,
    })

    this.store = this.createStore(this.projectDir)
    if (!this.store) {
      // createStore() already recorded `unavailable` with the concrete reason.
    } else if (this.projectLayerError) {
      this.health.fail(
        'storage',
        'project-layer-unavailable',
        `project memory disabled: ${this.projectLayerError}`,
      )
    } else if (!this.projectRoot) {
      // The Cordis process may start in `~` or the install directory rather
      // than the workspace. Global and habit memory keep working; the project
      // layer stays disabled and visibly degraded until a session anchors it.
      this.health.fail(
        'storage',
        'project-layer-unavailable',
        `no repository root detected from ${this.cwd}; project memory disabled (global and habit memory remain available)`,
      )
    } else {
      this.anchored = true
      this.health.ok('storage')
    }

    const engines = this.store ? this.buildEngines(this.store) : { memory: null, habit: null }
    this.memory = engines.memory
    this.habit = engines.habit

    this.health.setJudge(
      this.config.habit.judgeEnabled,
      this.judge.enabled,
      'judge model route unavailable; habit judgment falls back to rule mode (fail open)',
    )
    if (this.config.habit.enabled && !this.habit) {
      this.health.fail('habit', 'habit-engine-unavailable', 'habit learning unavailable: memory engine failed')
    }
    this.warning = this.health.warningLine()
    this.refresh(true)
  }

          projectDirFor(projectRoot        )         {
    return isAbsolute(this.config.projectMemoryDir)
      ? this.config.projectMemoryDir
      : join(projectRoot, this.config.projectMemoryDir)
  }

  /**
   * Open the layered store. A project root that aliases or nests the global /
   * habit roots drops only the project layer instead of taking the whole
   * runtime down; the concrete error is surfaced through `health`.
   */
          createStore(projectDir               )                      {
    const globalRoot = resolveMemoryPath(this.config.globalMemoryDir, this.dshHome)
    const habitRoot = resolveMemoryPath(this.config.habitDir, this.dshHome)
    const spillRoot = join(this.dshHome, 'storages', 'memory', 'spill')
    try {
      return new LayeredStore({ projectRoot: projectDir, globalRoot, habitRoot, spillRoot, now: this.now })
    } catch (error) {
      const message = (error         ).message
      if (projectDir) {
        try {
          const fallback = new LayeredStore({ projectRoot: null, globalRoot, habitRoot, spillRoot, now: this.now })
          this.projectLayerError = message
          return fallback
        } catch (fatal) {
          this.health.unavailableAll(`memory storage unavailable: ${(fatal         ).message}`)
          return null
        }
      }
      this.health.unavailableAll(`memory storage unavailable: ${message}`)
      return null
    }
  }

          buildEngines(store              )                                                             {
    try {
      const memory = new MemoryEngine({
        store,
        config: this.config,
        habitProfiles: () => this.profiles(),
        now: this.now,
      })
      const habit = new HabitEngine({
        store,
        memory,
        settings: this.config.habit,
        judge: this.judge,
        now: this.now,
        onJudgeSuccess: () => this.health.ok('judge'),
        onJudgeFailure: (reason) =>
          this.health.fail('judge', 'judge-failed', `judge call failed (${reason}); fail-open rule mode kept the originals`),
      })
      return { memory, habit }
    } catch (error) {
      this.health.fail('recall', 'engine-init-failed', `memory engine failed to initialize: ${(error         ).message}`)
      return { memory: null, habit: null }
    }
  }

  /**
   * Re-anchor the process to the repository of a real session workspace.
   *
   * DSH's process cwd is often `~` or the install directory, where it says
   * nothing about the repository the user opened. The session header carries
   * the authoritative workspace (`Session.header.cwd`); the first session that
   * has one anchors the project layer. Anchoring happens at most once per
   * process, so subsequent sessions keep sharing the first repository
   * (documented limitation).
   */
  anchor(cwd        )          {
    if (this.anchored || !cwd) return false
    const projectRoot = findProjectRoot(cwd, this.dshHome)
    if (!projectRoot) return false
    const projectDir = this.projectDirFor(projectRoot)
    const store = this.createStore(projectDir)
    if (!store) return false
    const engines = this.buildEngines(store)
    if (!engines.memory) return false
    this.projectRoot = projectRoot
    this.projectDir = projectDir
    this.store = store
    this.memory = engines.memory
    this.habit = engines.habit
    this.anchored = true
    this.health.ok('storage')
    if (this.config.habit.enabled && !this.habit) {
      this.health.fail('habit', 'habit-engine-unavailable', 'habit learning unavailable: memory engine failed')
    }
    this.warning = this.health.warningLine()
    this.refresh(true)
    return true
  }

  get available()          {
    return Boolean(this.store && this.memory)
  }

  require()                                                                    {
    if (!this.store || !this.memory || !this.habit) {
      throw new Error(this.health.warningLine() || 'memory runtime unavailable')
    }
    return { store: this.store, memory: this.memory, habit: this.habit }
  }

  profiles()                 {
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
  refresh(force = false)                  {
    if (!this.memory) {
      this.warning = this.health.warningLine()
      return { text: '', hash: '', lines: 0, chars: 0, omitted: 0, tier: 'none', habitLines: 0 }
    }
    const tier = 'full'         
    let entries                = []
    let signature        
    try {
      entries = this.memory.findAllCurrent()
      // Hand-edited NDJSON must be visible, not silently dropped. A bad line
      // degrades the index state (settings panel + status tool + prompt warning)
      // while readable entries stay usable; fixing the file recovers it.
      const corrupt = this.store?.corruptLineCount ?? 0
      if (corrupt > 0) {
        this.health.fail(
          'index',
          'corrupt-layer-lines',
          `${corrupt} unreadable NDJSON line(s) skipped in the memory stores; readable entries stay active, fix the file to recover`,
        )
      } else {
        this.health.ok('index')
      }
      this.warning = this.health.warningLine()
      signature = disclosureSignature(entries, this.profiles(), tier, this.warning)
      if (!force && signature === this.lastSignature && this.prefix.current) return this.prefix.current
    } catch (error) {
      signature = `index-error:${(error         ).message}`
    }
    const failed = signature.startsWith('index-error:')
    let block                 
    try {
      if (failed) throw new Error(signature.slice('index-error:'.length))
      block = buildDisclosure({ entries, habits: this.profiles(), config: this.config, tier, warning: this.warning })
    } catch (error) {
      // Visible degradation: the warning line itself becomes part of the
      // injected block, so "index broken" cannot be silent.
      this.health.fail('index', 'index-build-failed', `index build failed: ${(error         ).message}; falling back to one-line index`)
      this.warning = this.health.warningLine()
      signature = `index-error:${(error         ).message}`
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
  noteWarning()       {
    this.warning = this.health.warningLine()
  }

  noteRecallFailure(feature                                                  , code        , error         )       {
    const message = error instanceof Error ? error.message : String(error)
    this.health.fail(feature, code, message.slice(0, 240))
    this.noteWarning()
  }

  noteGuardRejection(error                )       {
    // Values are already stripped by guard.describe; report line + pattern only.
    this.health.fail('write', 'write-guard-rejected', error.message.slice(0, 240))
    this.noteWarning()
    this.store?.appendAudit({ type: 'health', actor: 'system', detail: `write degraded: ${error.violations.length} guard violation(s)` })
  }

  noteWriteOk()       {
    if (!this.health.readHiddenFeature('write')) {
      this.health.ok('write')
      this.noteWarning()
    }
  }

  statusReport(sessionId         )                          {
    const snapshot = this.health.snapshot()
    const warning = this.health.warningLine()
    if (!this.memory) {
      return { ok: false, health: snapshot, warning, config: this.config }
    }
    // Reading the stores can fail (I/O error, unreadable file). Status must
    // report that as a visible degraded failure instead of throwing out of a
    // tool call / HTTP handler.
    try {
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
    } catch (error) {
      this.health.fail('recall', 'status-read-failed', `status read failed: ${(error         ).message}`)
      this.noteWarning()
      return {
        ok: false,
        health: this.health.snapshot(),
        warning: this.health.warningLine(),
        error: (error         ).message,
      }
    }
  }

  dispose()       {
    this.prefix.update({ text: '', hash: '', lines: 0, chars: 0, omitted: 0, tier: 'full', habitLines: 0 }, 'disposed')
  }
}


//# sourceURL=runtime.ts