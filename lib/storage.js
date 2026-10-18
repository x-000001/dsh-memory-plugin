/**
 * Layered, isolated storage.
 *
 * Roots: project / global / habit. The constructor rejects aliased or nested
 * roots, and every write re-checks that the record's layer maps to the root it
 * claims, so a cross-layer write cannot succeed even if a caller forges an
 * entry object.
 *
 * Files per layer: `<root>/entries.ndjson` (active + archived + tombstones),
 * `<root>/audit.ndjson` (hash-chained audit trail). Habit state uses
 * `<habitRoot>/candidates.json` and `<habitRoot>/profiles.ndjson`.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
             
             
            
                 
                
               
                 
              
              
                   
import { shortId } from './types.js'

export class CrossLayerWriteError extends Error {
           code = 'CROSS_LAYER_WRITE'
  constructor(message        ) {
    super(message)
    this.name = 'CrossLayerWriteError'
  }
}

export class StoreInvariantError extends Error {
           code = 'STORE_INVARIANT'
  constructor(message        ) {
    super(message)
    this.name = 'StoreInvariantError'
  }
}

                               
                                                                                 
                            
                    
                   
                   
                    
 

                                 
                              
                              
                                                                      
                              
 

function canonical(path        )         {
  return resolve(path)
}

function contains(parent        , child        )          {
  const parentPath = resolve(parent)
  const childPath = resolve(child)
  return childPath === parentPath || childPath.startsWith(parentPath + sep)
}

export function fileContentHash(title        , body        )         {
  const normalized = `${title.trim().toLowerCase()}\n${body.replace(/\s+/g, ' ').trim().toLowerCase()}`
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

export class LayeredStore {
           projectRoot               
           globalRoot        
           habitRoot        
           spillRoot        
           auditFile        
                   now              
          auditSeq = 0
          auditHead = '0'.repeat(64)

  constructor(options              ) {
    this.now = options.now ?? Date.now
    this.projectRoot = options.projectRoot ? canonical(options.projectRoot) : null
    this.globalRoot = canonical(options.globalRoot)
    this.habitRoot = canonical(options.habitRoot)
    this.spillRoot = canonical(options.spillRoot)
    this.auditFile = join(this.globalRoot, 'audit.ndjson')

    const roots = [
      ['project', this.projectRoot],
      ['global', this.globalRoot],
      ['habit', this.habitRoot],
    ]         
    const seen = new Map                ()
    for (const [name, root] of roots) {
      if (!root) continue
      const lower = root.toLowerCase()
      const prior = seen.get(lower)
      if (prior) throw new StoreInvariantError(`memory roots must be distinct: ${name} aliases ${prior} (${root})`)
      seen.set(lower, name)
    }
    const pair = (a               , b        , an        , bn        )       => {
      if (a && (contains(a, b) || contains(b, a))) {
        throw new StoreInvariantError(`memory roots must not nest: ${an} (${a}) vs ${bn} (${b})`)
      }
    }
    pair(this.projectRoot, this.globalRoot, 'project', 'global')
    pair(this.projectRoot, this.habitRoot, 'project', 'habit')
    pair(this.globalRoot, this.habitRoot, 'global', 'habit')

    this.ensureDir(this.globalRoot)
    this.ensureDir(this.habitRoot)
    this.ensureDir(join(this.spillRoot))
    if (this.projectRoot) this.ensureDir(this.projectRoot)
    this.recoverAuditHead()
  }

          ensureDir(path        )       {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true })
      return
    }
    // A file where a directory is expected is a fatal store problem: report it
    // instead of silently writing nowhere later.
    if (!statSync(path).isDirectory()) {
      throw new StoreInvariantError(`memory root is not a directory: ${path}`)
    }
  }

          recoverAuditHead()       {
    const events = this.readAudit()
    const last = events[events.length - 1]
    this.auditSeq = last?.seq ?? 0
    this.auditHead = last?.hash ?? '0'.repeat(64)
  }

  layerRoot(layer             )         {
    if (layer === 'project') {
      if (!this.projectRoot) throw new CrossLayerWriteError('project memory layer is unavailable: no project root detected')
      return this.projectRoot
    }
    if (layer === 'global') return this.globalRoot
    return this.habitRoot
  }

  entriesFile(layer             )         {
    return join(this.layerRoot(layer), 'entries.ndjson')
  }

  /** Hard isolation gate used by every write. */
  assertLayerRoot(layer             , targetRoot        )       {
    const expected = this.layerRoot(layer)
    if (canonical(targetRoot) !== expected) {
      throw new CrossLayerWriteError(
        `refusing cross-layer write: ${layer} entry targeted ${targetRoot}, expected ${expected}`,
      )
    }
  }

  readLayer(layer             )                {
    return this.readNdjson             (this.entriesFile(layer))
  }

  /** Append one record; the record must carry a layer matching this store. */
  appendEntry(layer             , entry             )       {
    this.assertLayerRoot(layer, this.layerRoot(layer))
    if (entry.layer !== layer) {
      throw new CrossLayerWriteError(`entry.layer=${entry.layer} cannot be written to ${layer} store`)
    }
    this.appendLine(this.entriesFile(layer), entry)
  }

  /** Atomic rewrite used by compaction/consolidation; keeps line-per-record format. */
  rewriteLayer(layer             , entries               )       {
    for (const entry of entries) {
      if (entry.layer !== layer) throw new CrossLayerWriteError(`rewrite contains foreign entry ${entry.id} (${entry.layer})`)
    }
    const file = this.entriesFile(layer)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
  }

  list(layer              )                {
    if (layer) return this.readLayer(layer)
    const layers                = ['global', 'habit']
    if (this.projectRoot) layers.unshift('project')
    return layers.flatMap((l) => this.readLayer(l))
  }

  appendAudit(input   
                   
                              
                  
                      
                    
                       
                
   )             {
    const ts = input.now ?? this.now()
    const seq = ++this.auditSeq
    const payload = {
      seq,
      ts,
      type: input.type,
      actor: input.actor,
      sessionId: input.sessionId ?? null,
      entryId: input.entryId ?? null,
      layer: input.layer ?? null,
      detail: input.detail,
    }
    const prevHash = this.auditHead
    const hash = createHash('sha256').update(prevHash).update(JSON.stringify(payload)).digest('hex')
    const event             = {
      seq,
      ts,
      type: input.type,
      actor: input.actor,
      sessionId: input.sessionId,
      entryId: input.entryId,
      layer: input.layer,
      detail: input.detail,
      prevHash,
      hash,
    }
    this.appendLine(this.auditFile, event)
    this.auditHead = hash
    return event
  }

  readAudit(limit         )               {
    if (!existsSync(this.auditFile)) return []
    const events = this.readNdjson            (this.auditFile)
    return typeof limit === 'number' ? events.slice(-limit) : events
  }

  /** Verify the audit chain; returns the first broken seq or null when intact. */
  verifyAuditChain()                {
    let prev = '0'.repeat(64)
    let seq = 0
    for (const event of this.readAudit()) {
      if (event.seq !== seq + 1) return event.seq
      if (event.prevHash !== prev) return event.seq
      const payload = {
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        actor: event.actor,
        sessionId: event.sessionId ?? null,
        entryId: event.entryId ?? null,
        layer: event.layer ?? null,
        detail: event.detail,
      }
      const expected = createHash('sha256').update(prev).update(JSON.stringify(payload)).digest('hex')
      if (event.hash !== expected) return event.seq
      prev = event.hash
      seq = event.seq
    }
    return null
  }

  loadHabitState()                 {
    const file = join(this.habitRoot, 'candidates.json')
    if (!existsSync(file)) return { candidates: [], tombstones: [] }
    const raw = JSON.parse(readFileSync(file, 'utf8'))                  
    return { candidates: raw.candidates ?? [], tombstones: raw.tombstones ?? [] }
  }

  saveHabitState(state                )       {
    const file = join(this.habitRoot, 'candidates.json')
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  addHabitTombstone(pattern        , reason        )                 {
    const state = this.loadHabitState()
    const tombstone                 = { id: shortId('tomb'), pattern, at: this.now(), reason }
    state.tombstones.push(tombstone)
    this.saveHabitState(state)
    return tombstone
  }

  readHabitProfiles()                 {
    return this.readNdjson              (join(this.habitRoot, 'profiles.ndjson'))
  }

  appendHabitSignal(signal               )       {
    this.appendLine(join(this.habitRoot, 'signals.ndjson'), signal)
  }

  readHabitSignals()                  {
    return this.readNdjson               (join(this.habitRoot, 'signals.ndjson'))
  }

  appendHabitTrigger(sessionId        )       {
    this.appendLine(join(this.habitRoot, 'triggers.ndjson'), { sessionId, at: this.now() })
  }

  readHabitTriggers()           {
    return this.readNdjson                       (join(this.habitRoot, 'triggers.ndjson')).map((t) => t.sessionId)
  }

  rewriteHabitProfiles(profiles                )       {
    const file = join(this.habitRoot, 'profiles.ndjson')
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, profiles.map((p) => JSON.stringify(p)).join('\n') + (profiles.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
  }

  /** Long-task unload: keep the full payload addressable on disk. */
  spill(sessionId        , label        , content        )         {
    const dir = join(this.spillRoot, sanitizeSegment(sessionId))
    this.ensureDir(dir)
    const file = join(dir, `${sanitizeSegment(label)}.txt`)
    writeFileSync(file, content, 'utf8')
    return file
  }

  readSpill(path        )                {
    const resolved = resolve(path)
    if (!resolved.startsWith(this.spillRoot + sep)) return null
    if (!existsSync(resolved)) return null
    return readFileSync(resolved, 'utf8')
  }

  removeSpill(path        )       {
    const resolved = resolve(path)
    if (!resolved.startsWith(this.spillRoot + sep)) return
    if (existsSync(resolved)) rmSync(resolved, { force: true })
  }

          appendLine(file        , value         )       {
    this.ensureDir(join(file, '..'))
    appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
  }

                   corruptFiles = new Map                ()

  /** Number of NDJSON lines skipped as unreadable during the latest reads. */
  get corruptLineCount()         {
    let total = 0
    for (const value of this.corruptFiles.values()) total += value
    return total
  }

  get corruptFilesList()           {
    return [...this.corruptFiles.keys()]
  }

          readNdjson   (file        )      {
    if (!existsSync(file)) {
      this.corruptFiles.delete(file)
      return []
    }
    const out      = []
    let corrupt = 0
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed)     )
      } catch {
        // A hand-edited bad line must not make the whole store unreadable,
        // but it must not be silent either: refresh() surfaces the count.
        corrupt += 1
      }
    }
    if (corrupt > 0) this.corruptFiles.set(file, corrupt)
    else this.corruptFiles.delete(file)
    return out
  }
}

function sanitizeSegment(value        )         {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unnamed'
}

export function resolveHomePath(path        , home        )         {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}


//# sourceURL=storage.ts