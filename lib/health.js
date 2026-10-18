/**
 * Three-state health model, materialized into a user-visible state file.
 *
 * `active`     — all enabled features work.
 * `degraded`   — at least one enabled feature is impaired; the reason and the
 *                affected scope are written into the state file and the
 *                status tool / settings card read from it.
 * `unavailable`— memory cannot be read or written at all (e.g. all roots fail).
 *
 * Silent degradation is a bug: every failure goes through `fail()`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
                                                                            

                                                                                        

export const HEALTH_FEATURES                  = ['storage', 'index', 'recall', 'write', 'habit', 'judge']

export class HealthTracker {
                   stateFile        
                   now              
                   reasons = new Map                      ()
                   features                          = {}
          unavailable = false
          lastWrite = 0

  constructor(options                                           ) {
    this.stateFile = options.stateFile
    this.now = options.now ?? Date.now
    for (const feature of HEALTH_FEATURES) this.features[feature] = true
    this.persist()
  }

          status()               {
    if (this.unavailable) return 'unavailable'
    return this.reasons.size > 0 ? 'degraded' : 'active'
  }

          persist()       {
    const snapshot = this.snapshot()
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(snapshot, null, 2), 'utf8')
    } catch {
      // Health reporting must never take the plugin down.
    }
  }

  snapshot()                 {
    return {
      status: this.status(),
      reasons: [...this.reasons.values()],
      features: { ...this.features },
      updatedAt: this.now(),
      stateFile: this.stateFile,
    }
  }

  ok(feature               , note         )                 {
    this.features[feature] = true
    for (const [key, reason] of [...this.reasons]) {
      if (reason.scope === feature) this.reasons.delete(key)
    }
    if (note) {
      // Successful recovery still leaves a trail in the audit log, not in health.
    }
    if (this.now() - this.lastWrite > 250) this.persist()
    return this.snapshot()
  }

  /** Degrade one feature; repeated reasons are collapsed by code. */
  fail(feature               , code        , message        )                 {
    this.features[feature] = false
    this.reasons.set(`${feature}:${code}`, { code, message, scope: feature })
    this.persist()
    return this.snapshot()
  }

  setJudge(enabled         , available         , message        )                 {
    if (!enabled) {
      this.features.judge = false
      for (const key of [...this.reasons.keys()]) if (key.startsWith('judge:')) this.reasons.delete(key)
      this.persist()
      return this.snapshot()
    }
    if (available) return this.ok('judge')
    return this.fail('judge', 'judge-unavailable', message)
  }

  /** Fatal storage problem: memory cannot operate. */
  unavailableAll(message        )                 {
    this.unavailable = true
    this.reasons.set('storage:fatal', { code: 'storage-unavailable', message, scope: 'storage' })
    for (const feature of HEALTH_FEATURES) if (feature !== 'storage') this.features[feature] = false
    this.features.storage = false
    this.persist()
    return this.snapshot()
  }

  /** One-line, user-visible warning. Empty string when active. */
  warningLine()         {
    const snapshot = this.snapshot()
    if (snapshot.status === 'active') return ''
    const detail = snapshot.reasons.map((r) => `[${r.scope}] ${r.code}: ${r.message}`).join(' | ')
    return `dsh-memory ${snapshot.status.toUpperCase()}: ${detail} (state: ${snapshot.stateFile})`
  }

  readHiddenFeature(feature               )          {
    return this.features[feature] !== false
  }
}


//# sourceURL=health.ts