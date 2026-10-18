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
import type {
  AuditEvent,
  AuditType,
  HabitCandidate,
  HabitEvidence,
  HabitProfile,
  HabitTombstone,
  MemoryEntry,
  MemoryLayer,
} from './types.ts'
import { shortId } from './types.ts'

export class CrossLayerWriteError extends Error {
  readonly code = 'CROSS_LAYER_WRITE'
  constructor(message: string) {
    super(message)
    this.name = 'CrossLayerWriteError'
  }
}

export class StoreInvariantError extends Error {
  readonly code = 'STORE_INVARIANT'
  constructor(message: string) {
    super(message)
    this.name = 'StoreInvariantError'
  }
}

export interface StoreOptions {
  /** Absolute repo root; when absent the project layer is read-only/disabled. */
  projectRoot: string | null
  globalRoot: string
  habitRoot: string
  spillRoot: string
  now?: () => number
}

export interface HabitStateFile {
  candidates: HabitCandidate[]
  tombstones: HabitTombstone[]
  /** Session ids that already consumed their one judgment trigger. */
  triggeredSessions?: string[]
}

function canonical(path: string): string {
  return resolve(path)
}

function contains(parent: string, child: string): boolean {
  const parentPath = resolve(parent)
  const childPath = resolve(child)
  return childPath === parentPath || childPath.startsWith(parentPath + sep)
}

export function fileContentHash(title: string, body: string): string {
  const normalized = `${title.trim().toLowerCase()}\n${body.replace(/\s+/g, ' ').trim().toLowerCase()}`
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

export class LayeredStore {
  readonly projectRoot: string | null
  readonly globalRoot: string
  readonly habitRoot: string
  readonly spillRoot: string
  readonly auditFile: string
  private readonly now: () => number
  private auditSeq = 0
  private auditHead = '0'.repeat(64)

  constructor(options: StoreOptions) {
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
    ] as const
    const seen = new Map<string, string>()
    for (const [name, root] of roots) {
      if (!root) continue
      const lower = root.toLowerCase()
      const prior = seen.get(lower)
      if (prior) throw new StoreInvariantError(`memory roots must be distinct: ${name} aliases ${prior} (${root})`)
      seen.set(lower, name)
    }
    const pair = (a: string | null, b: string, an: string, bn: string): void => {
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

  private ensureDir(path: string): void {
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

  private recoverAuditHead(): void {
    const events = this.readAudit()
    const last = events[events.length - 1]
    this.auditSeq = last?.seq ?? 0
    this.auditHead = last?.hash ?? '0'.repeat(64)
  }

  layerRoot(layer: MemoryLayer): string {
    if (layer === 'project') {
      if (!this.projectRoot) throw new CrossLayerWriteError('project memory layer is unavailable: no project root detected')
      return this.projectRoot
    }
    if (layer === 'global') return this.globalRoot
    return this.habitRoot
  }

  entriesFile(layer: MemoryLayer): string {
    return join(this.layerRoot(layer), 'entries.ndjson')
  }

  /** Hard isolation gate used by every write. */
  assertLayerRoot(layer: MemoryLayer, targetRoot: string): void {
    const expected = this.layerRoot(layer)
    if (canonical(targetRoot) !== expected) {
      throw new CrossLayerWriteError(
        `refusing cross-layer write: ${layer} entry targeted ${targetRoot}, expected ${expected}`,
      )
    }
  }

  readLayer(layer: MemoryLayer): MemoryEntry[] {
    return this.readNdjson<MemoryEntry>(this.entriesFile(layer))
  }

  /** Append one record; the record must carry a layer matching this store. */
  appendEntry(layer: MemoryLayer, entry: MemoryEntry): void {
    this.assertLayerRoot(layer, this.layerRoot(layer))
    if (entry.layer !== layer) {
      throw new CrossLayerWriteError(`entry.layer=${entry.layer} cannot be written to ${layer} store`)
    }
    this.appendLine(this.entriesFile(layer), entry)
  }

  /** Atomic rewrite used by compaction/consolidation; keeps line-per-record format. */
  rewriteLayer(layer: MemoryLayer, entries: MemoryEntry[]): void {
    for (const entry of entries) {
      if (entry.layer !== layer) throw new CrossLayerWriteError(`rewrite contains foreign entry ${entry.id} (${entry.layer})`)
    }
    const file = this.entriesFile(layer)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
  }

  list(layer?: MemoryLayer): MemoryEntry[] {
    if (layer) return this.readLayer(layer)
    const layers: MemoryLayer[] = ['global', 'habit']
    if (this.projectRoot) layers.unshift('project')
    return layers.flatMap((l) => this.readLayer(l))
  }

  appendAudit(input: {
    type: AuditType
    actor: AuditEvent['actor']
    detail: string
    sessionId?: string
    entryId?: string
    layer?: MemoryLayer
    now?: number
  }): AuditEvent {
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
    const event: AuditEvent = {
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

  readAudit(limit?: number): AuditEvent[] {
    if (!existsSync(this.auditFile)) return []
    const events = this.readNdjson<AuditEvent>(this.auditFile)
    return typeof limit === 'number' ? events.slice(-limit) : events
  }

  /** Verify the audit chain; returns the first broken seq or null when intact. */
  verifyAuditChain(): number | null {
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

  loadHabitState(): HabitStateFile {
    const file = join(this.habitRoot, 'candidates.json')
    if (!existsSync(file)) return { candidates: [], tombstones: [] }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as HabitStateFile
    return { candidates: raw.candidates ?? [], tombstones: raw.tombstones ?? [] }
  }

  saveHabitState(state: HabitStateFile): void {
    const file = join(this.habitRoot, 'candidates.json')
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  addHabitTombstone(pattern: string, reason: string): HabitTombstone {
    const state = this.loadHabitState()
    const tombstone: HabitTombstone = { id: shortId('tomb'), pattern, at: this.now(), reason }
    state.tombstones.push(tombstone)
    this.saveHabitState(state)
    return tombstone
  }

  readHabitProfiles(): HabitProfile[] {
    return this.readNdjson<HabitProfile>(join(this.habitRoot, 'profiles.ndjson'))
  }

  appendHabitSignal(signal: HabitEvidence): void {
    this.appendLine(join(this.habitRoot, 'signals.ndjson'), signal)
  }

  readHabitSignals(): HabitEvidence[] {
    return this.readNdjson<HabitEvidence>(join(this.habitRoot, 'signals.ndjson'))
  }

  appendHabitTrigger(sessionId: string): void {
    this.appendLine(join(this.habitRoot, 'triggers.ndjson'), { sessionId, at: this.now() })
  }

  readHabitTriggers(): string[] {
    return this.readNdjson<{ sessionId: string }>(join(this.habitRoot, 'triggers.ndjson')).map((t) => t.sessionId)
  }

  rewriteHabitProfiles(profiles: HabitProfile[]): void {
    const file = join(this.habitRoot, 'profiles.ndjson')
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, profiles.map((p) => JSON.stringify(p)).join('\n') + (profiles.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
  }

  /** Long-task unload: keep the full payload addressable on disk. */
  spill(sessionId: string, label: string, content: string): string {
    const dir = join(this.spillRoot, sanitizeSegment(sessionId))
    this.ensureDir(dir)
    const file = join(dir, `${sanitizeSegment(label)}.txt`)
    writeFileSync(file, content, 'utf8')
    return file
  }

  readSpill(path: string): string | null {
    const resolved = resolve(path)
    if (!resolved.startsWith(this.spillRoot + sep)) return null
    if (!existsSync(resolved)) return null
    return readFileSync(resolved, 'utf8')
  }

  removeSpill(path: string): void {
    const resolved = resolve(path)
    if (!resolved.startsWith(this.spillRoot + sep)) return
    if (existsSync(resolved)) rmSync(resolved, { force: true })
  }

  private appendLine(file: string, value: unknown): void {
    this.ensureDir(join(file, '..'))
    appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
  }

  private readNdjson<T>(file: string): T[] {
    if (!existsSync(file)) return []
    const out: T[] = []
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as T)
      } catch {
        // A hand-edited bad line must not make the whole store unreadable.
      }
    }
    return out
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unnamed'
}

export function resolveHomePath(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}
