/**
 * Memory engine: write path (guard -> isolation -> dedupe/version), recall
 * path (keyword relevance -> per-call/session caps -> disclosure dedupe),
 * expand, forget, feedback and the lifecycle chain.
 *
 * Zero model calls: every operation here is deterministic.
 */
import { BudgetBook, clampRecallOptions, priorityAtLeast, recallLimitsFor, planIndex } from './budget.js'
import { WriteGuard } from './guard.js'
import { CrossLayerWriteError, fileContentHash, LayeredStore } from './storage.js'
             
                
               
                
                    
              
              
                     
                 
                   
                
               
               
                   
import { estimateTokens, firstSentence, shortId } from './types.js'

export class GuardRejection extends Error {
           code = 'WRITE_GUARD_REJECT'
           violations                                     
  constructor(message        , violations                                     ) {
    super(message)
    this.name = 'GuardRejection'
    this.violations = violations
  }
}

                               
            
                 
                    
                  
                           
                
               
 

                                                          
                   
 

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'it', 'as', 'at', 'by', 'from', 'we', 'you', 'i', 'me', 'my', 'our', 'us', 'do', 'does', 'did',
  '的', '了', '是', '在', '和', '与', '我', '你', '他', '她', '它', '们', '这', '那', '有', '就', '也', '都', '很',
])

export function tokenize(text        )           {
  const lowered = text.toLowerCase()
  const latin = lowered.match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? []
  const cjk = lowered.match(/[\u4e00-\u9fff]{1,4}/g) ?? []
  const words = [...latin, ...cjk].filter((w) => !STOPWORDS.has(w) && w.length > 1)
  return [...new Set(words)].slice(0, 32)
}

const PRIORITY_BOOST                                 = { P0: 0.35, P1: 0.2, P2: 0.1 }

export function relevanceScore(entry             , queryTokens          , now        )         {
  if (queryTokens.length === 0) {
    const ageDays = (now - entry.updatedAt) / 86_400_000
    return 0.5 + PRIORITY_BOOST[entry.priority] + entry.confidence * 0.2 - Math.min(0.4, ageDays / 365)
  }
  // Exact token membership, not substring: "where" must not match "everywhere".
  const titleTokens = new Set(tokenize(entry.title))
  const tagTokens = new Set(tokenize(entry.tags.join(' ')))
  const summaryTokens = new Set(tokenize(entry.summary))
  const bodyTokens = new Set(tokenize(entry.body))
  let score = 0
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 3
    if (tagTokens.has(token)) score += 2.2
    if (summaryTokens.has(token)) score += 1.6
    if (bodyTokens.has(token)) score += 0.7
  }
  if (score === 0) return 0
  const lengthPenalty = Math.sqrt(Math.max(1, entry.body.length / 1_200))
  const recency = Math.exp(-Math.max(0, now - entry.updatedAt) / (45 * 86_400_000))
  return score / lengthPenalty + recency * 0.4 + entry.confidence * 0.2 + PRIORITY_BOOST[entry.priority]
}

                                     
                                               
                                  
                           
                                                                               
                                                                   
                                                                                
 

export class MemoryEngine {
           store              
           config                    
           guard            
           budgets            
           now              
                   habitProfiles                      
                   appends = new Map                     ()

  /** Physical rows written to one layer file before it is compacted in place. */
  static          COMPACT_EVERY = 256

  constructor(options   
                       
                              
                                        
                      
   ) {
    this.store = options.store
    this.config = options.config
    this.guard = new WriteGuard(options.config.guard)
    this.budgets = new BudgetBook(options.config.budget)
    this.now = options.now ?? Date.now
    this.habitProfiles = options.habitProfiles ?? (() => [])
  }

  /**
   * Append one row, then compact that layer once enough rows have accumulated.
   *
   * Recall/feedback/tombstone updates are append-only by design (auditable
   * history), but without compaction an append per recall makes the NDJSON file
   * grow without bound: 200 recalls of a single memory grew it from 454 B to
   * 104 KB in a probe, and every recall re-parses the whole file. Compaction
   * keeps the last physical row per (id, version), so version history and
   * tombstone/confidence updates survive while stale duplicates are dropped.
   */
          append(layer             , entry             )       {
    this.store.appendEntry(layer, entry)
    const count = (this.appends.get(layer) ?? 0) + 1
    if (count >= MemoryEngine.COMPACT_EVERY) {
      this.appends.set(layer, 0)
      this.compact(layer)
    } else {
      this.appends.set(layer, count)
    }
  }

  /** Merge duplicate (id, version) rows in one layer. Returns rows removed. */
  compact(layer             )         {
    const rows = this.store.readLayer(layer)
    if (rows.length === 0) return 0
    const last = new Map                     ()
    for (const row of rows) last.set(`${row.id}@${row.version}`, row)
    const kept = [...last.values()]
    if (kept.length === rows.length) return 0
    this.store.rewriteLayer(layer, kept)
    this.store.appendAudit({
      type: 'compact',
      actor: 'system',
      layer,
      detail: `compacted ${rows.length} row(s) -> ${kept.length} row(s)`,
    })
    return rows.length - kept.length
  }

  /** Write one memory. Guard runs before anything touches disk. */
  write(input                  , layer             , actor                   = 'agent', sessionId         )               {
    const title = input.title.trim()
    const body = input.body.trim()
    if (!title || !body) throw new Error('memory_remember requires non-empty title and body')
    const path = `${layer}/entries.ndjson`
    // Scan EVERY field that is persisted or later rendered into the resident
    // index (title, summary, tags, body). Scanning only title+body let a secret
    // ride in through `tags` or `summary` and reach both disk and the prompt.
    const summary = (input.summary ?? '').trim()
    const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : []
    const scanLines = [title]
    if (summary) scanLines.push(`summary: ${summary}`)
    if (tags.length) scanLines.push(`tags: ${tags.join(', ')}`)
    scanLines.push(body)
    const content = scanLines.join('\n')
    const guard = this.guard.scan(content)
    if (!guard.ok) {
      const detail = this.guard.describe(guard.violations, path)
      this.store.appendAudit({ type: 'write-guard-reject', actor: 'system', detail, sessionId, layer })
      throw new GuardRejection(detail, guard.violations)
    }

    const now = this.now()
    const hash = fileContentHash(title, body)
    const entries = this.store.readLayer(layer)
    const scope = input.scope ?? this.scopeFor(layer)

    const duplicate = entries.find((e) => e.status !== 'tombstone' && e.contentHash === hash)
    if (duplicate) {
      this.store.appendAudit({
        type: 'dedupe',
        actor,
        sessionId,
        entryId: duplicate.id,
        layer,
        detail: `duplicate content hash ${hash.slice(0, 12)}; kept v${duplicate.version}`,
      })
      return {
        id: duplicate.id,
        version: duplicate.version,
        layer,
        deduped: true,
        superseded: null,
        tokens: duplicate.tokens,
        chars: duplicate.body.length,
      }
    }

    const previous = entries
      .filter(
        (e) => e.layer === layer && e.status !== 'tombstone' && e.status !== 'archived' && e.title.trim().toLowerCase() === title.toLowerCase(),
      )
      .sort((a, b) => b.version - a.version)[0]
    const version = previous ? previous.version + 1 : 1
    const entry              = {
      id: previous ? previous.id : shortId('mem'),
      version,
      layer,
      scope,
      title,
      tags: tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
      summary: firstSentence(summary || body, 140),
      body,
      status: 'active',
      priority: input.priority ?? 'P2',
      confidence: input.source === 'user' ? 1 : 0.7,
      source: input.source ?? 'user',
      contentHash: hash,
      tokens: estimateTokens(body),
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      recallCount: 0,
      supersedes: previous ? previous.version : undefined,
    }
    if (previous) {
      // Archive the superseded revision in place (history stays in the file:
      // one archived line + one current line) instead of appending a copy that
      // would make the same id appear twice at the same version.
      const archived              = { ...previous, status: 'archived', updatedAt: now }
      const rewritten = entries.map((e) =>
        e.id === previous.id && e.version === previous.version ? archived : e,
      )
      this.store.rewriteLayer(layer, rewritten)
      this.append(layer, entry)
      this.store.appendAudit({
        type: 'supersede',
        actor,
        sessionId,
        entryId: entry.id,
        layer,
        detail: `v${version} supersedes v${previous.version}; history retained`,
      })
    } else {
      this.append(layer, entry)
    }
    this.store.appendAudit({
      type: 'remember',
      actor,
      sessionId,
      entryId: entry.id,
      layer,
      detail: `${title} (${entry.priority}, ${entry.tokens} est. tokens)`,
    })
    return { id: entry.id, version, layer, deduped: false, superseded: previous?.version ?? null, tokens: entry.tokens, chars: body.length }
  }

  /** Current visible version of one entry id. */
  findCurrent(layer             , id        )                     {
    const entries = this.store.readLayer(layer)
    const mine = entries.filter((e) => e.id === id)
    if (!mine.length) return null
    return mine.reduce((best, cur) => (cur.version > best.version ? cur : best))
  }

  findAllCurrent(layer              )                {
    const layers                = layer ? [layer] : this.store.projectRoot ? ['project', 'global', 'habit'] : ['global', 'habit']
    const out                = []
    for (const l of layers) {
      const byId = new Map                     ()
      for (const entry of this.store.readLayer(l)) {
        const prior = byId.get(entry.id)
        // Append-only log: for equal versions the later line wins (tombstone /
        // confidence updates reuse the version number on purpose).
        if (!prior || entry.version >= prior.version) byId.set(entry.id, entry)
      }
      for (const entry of byId.values()) {
        if (entry.status === 'active' || entry.status === 'dormant') out.push(entry)
      }
    }
    return out
  }

  /**
   * Recall with progressive disclosure: only title/summary/excerpt come back,
   * and each entry is injected at most once per session.
   */
  recall(options                   )               {
    const session = this.budgets.session(options.sessionId)
    const opts = clampRecallOptions(options, this.config.budget)
    const limits = recallLimitsFor(this.config.budget, session.tier)
    const now = this.now()
    const queryTokens = tokenize(options.query ?? '')
    const candidates = this.findAllCurrent(options.layer)
      .filter((e) => e.status === 'active')
      .filter((e) => (options.tags?.length ? options.tags.some((t) => e.tags.includes(t)) : true))
      .map((entry) => ({ entry, score: relevanceScore(entry, queryTokens, now) }))
      .filter((c) => c.score >= 0.25)
      .sort((a, b) => b.score - a.score)

    const dedupedIds           = []
    // Dedupe happens before any budget decision: a fully disclosed result set
    // must return `dedupedIds` even when the session budget is nearly spent.
    const fresh = candidates.filter(({ entry }) => {
      if (!session.disclosed.has(entry.id)) return true
      dedupedIds.push(entry.id)
      return options.allowRepeat === true
    })
    const maxTotal = Math.min(opts.maxTotalRecallChars ?? limits.maxTotalChars, limits.maxTotalChars, session.remaining())
    const perMemory = Math.min(opts.maxCharsPerMemory ?? limits.maxCharsPerMemory, limits.maxCharsPerMemory)
    const items                        = []
    let spent = 0

    if (fresh.length === 0) {
      return {
        items: [],
        tier: session.tier,
        degraded: session.tier !== 'full',
        degradationReasons: [...session.reasons],
        spentChars: 0,
        sessionSpentChars: session.spentChars,
        sessionBudgetChars: session.budgetChars,
        dedupedIds,
        hint: dedupedIds.length
          ? 'already disclosed in this session; call memory_expand(id) or pass allowRepeat'
          : 'no relevant active memory',
      }
    }

    if (maxTotal <= 60) {
      session.degrade('session-recall-budget', this.budgets.order)
      this.store.appendAudit({
        type: 'degradation',
        actor: 'system',
        sessionId: options.sessionId,
        detail: `tier=${session.tier} reason=session-recall-budget spent=${session.spentChars}/${session.budgetChars}`,
      })
      return {
        items: [],
        tier: session.tier,
        degraded: true,
        degradationReasons: [...session.reasons],
        spentChars: 0,
        sessionSpentChars: session.spentChars,
        sessionBudgetChars: session.budgetChars,
        dedupedIds,
        hint: 'session recall budget exhausted: expand a specific id or start a new session',
      }
    }

    for (const { entry, score } of fresh) {
      if (items.length >= Math.min(opts.maxResults ?? limits.maxResults, limits.maxResults)) break
      const remaining = maxTotal - spent
      if (remaining < 80) break
      const room = Math.min(perMemory, remaining)
      const excerpt = entry.body.length > room ? `${entry.body.slice(0, Math.max(40, room - 3))}...` : entry.body
      items.push({
        id: entry.id,
        version: entry.version,
        layer: entry.layer,
        title: entry.title,
        summary: entry.summary,
        excerpt,
        chars: excerpt.length,
        score: Math.round(score * 1000) / 1000,
        priority: entry.priority,
        truncated: entry.body.length > excerpt.length,
      })
      spent += excerpt.length
      session.disclosed.add(entry.id)
    }

    session.spentChars += spent
    if (spent > 0) {
      this.store.appendAudit({
        type: 'recall',
        actor: 'agent',
        sessionId: options.sessionId,
        detail: `query="${(options.query ?? '').slice(0, 80)}" injected=${items.length} chars=${spent} tier=${session.tier}`,
      })
      for (const item of items) {
        this.bumpRecall(item.id, item.layer, options.sessionId)
      }
    }

    return {
      items,
      tier: session.tier,
      degraded: session.tier !== 'full',
      degradationReasons: [...session.reasons],
      spentChars: spent,
      sessionSpentChars: session.spentChars,
      sessionBudgetChars: session.budgetChars,
      dedupedIds,
      hint: items.length ? 'bodies stay on disk; call memory_expand(id) for full text' : 'no relevant active memory',
    }
  }

          bumpRecall(id        , layer             , sessionId        )       {
    const current = this.findCurrent(layer, id)
    if (!current) return
    const now = this.now()
    const updated              = {
      ...current,
      recallCount: current.recallCount + 1,
      lastRecalledAt: now,
      lastRecalledSession: sessionId,
      updatedAt: current.updatedAt,
    }
    this.append(layer, updated)
  }

  /** Full body disclosure for one explicit id; still bounded per call. */
  expand(id        , sessionId        , maxChars         )                                                                                                                     {
    const session = this.budgets.session(sessionId)
    const totals = this.findAllCurrent()
    const entry = totals.find((e) => e.id === id)
    if (!entry) return { found: false, chars: 0, tier: session.tier, remainingChars: session.remaining() }
    // The session recall budget is a hard cap, not advisory: an explicit expand
    // may never inject more characters than the session has left, so repeated
    // expands cannot bypass the progressive-disclosure budget.
    const requested = Math.max(200, Math.min(maxChars ?? 8_000, this.config.budget.recallMaxCharsPerMemory * 4))
    const cap = Math.min(requested, session.remaining())
    const body = cap <= 0 ? '' : entry.body.length > cap ? `${entry.body.slice(0, Math.max(0, cap - 3))}...` : entry.body
    session.spentChars += body.length
    if (body.length > 0) session.disclosed.add(entry.id)
    this.store.appendAudit({
      type: 'expand',
      actor: 'agent',
      sessionId,
      entryId: entry.id,
      layer: entry.layer,
      detail: `expanded ${body.length} chars (cap ${cap}, remaining ${session.remaining()})`,
    })
    return { found: true, entry: { ...entry, body }, body, chars: body.length, tier: session.tier, remainingChars: session.remaining() }
  }

  /** Tombstone write; P0 and user-authored entries need an explicit force. */
  forget(id        , actor                  , reason        , force = false)                                              {
    const all = this.findAllCurrent()
    const entry = all.find((e) => e.id === id)
    if (!entry) return { ok: false, id, reason: 'not found' }
    const protectedEntry = entry.priority === 'P0' || (this.config.lifecycle.userMemoryProtected && entry.source === 'user')
    if (protectedEntry && !force) {
      return { ok: false, id, reason: 'protected: P0 or user-authored memory requires force=true from an explicit user instruction' }
    }
    const now = this.now()
    this.append(entry.layer, { ...entry, status: 'tombstone', updatedAt: now })
    this.store.appendAudit({
      type: 'forget',
      actor,
      entryId: entry.id,
      layer: entry.layer,
      detail: `tombstoned (${reason.slice(0, 120)})`,
    })
    return { ok: true, id, reason: 'tombstoned' }
  }

  feedback(id        , signal                    , actor                  )                                      {
    const entry = this.findAllCurrent().find((e) => e.id === id)
    if (!entry) return { ok: false, confidence: 0 }
    const delta = signal === 'useful' ? 0.08 : -0.2
    const confidence = Math.max(0.05, Math.min(1, Math.round((entry.confidence + delta) * 100) / 100))
    const flagged = signal === 'wrong' ? true : entry.flagged
    this.append(entry.layer, { ...entry, confidence, flagged, updatedAt: this.now() })
    this.store.appendAudit({
      type: 'feedback',
      actor,
      entryId: entry.id,
      layer: entry.layer,
      detail: `${signal} -> confidence ${confidence}`,
    })
    return { ok: true, confidence }
  }

  /** Promote a project entry into the global store. Human confirmation required. */
  promoteToGlobal(id        , confirmed         , actor                  )                                               {
    const entry = this.findAllCurrent('project').find((e) => e.id === id)
    if (!entry) return { ok: false, reason: 'project entry not found' }
    if (!confirmed) {
      return { ok: false, reason: 'promotion to global memory requires explicit user confirmation (confirmed=true)' }
    }
    try {
      const outcome = this.write(
        {
          title: entry.title,
          body: entry.body,
          tags: entry.tags,
          priority: entry.priority === 'P0' ? 'P1' : entry.priority,
          source: 'user',
          summary: entry.summary,
          scope: '__global__',
        },
        'global',
        actor,
      )
      this.store.appendAudit({
        type: 'remember',
        actor,
        entryId: outcome.id,
        layer: 'global',
        detail: `promoted from project ${entry.id} v${entry.version}`,
      })
      return { ok: true, id: outcome.id, reason: 'promoted to global memory' }
    } catch (error) {
      if (error instanceof CrossLayerWriteError) return { ok: false, reason: error.message }
      throw error
    }
  }

  /** Lifecycle chain: expire -> dormant -> weak renewal -> capacity -> physical delete. */
  consolidate()   
                   
                   
                   
                   
                
    {
    const now = this.now()
    const lifecycle                    = this.config.lifecycle
    const day = 86_400_000
    const report = { expired: 0, dormant: 0, evicted: 0, deleted: 0, kept: 0 }
    const layers                = this.store.projectRoot ? ['project', 'global', 'habit'] : ['global', 'habit']

    for (const layer of layers) {
      const entries = this.store.readLayer(layer)
      const latest = new Map                     ()
      for (const entry of entries) {
        const prior = latest.get(entry.id)
        if (!prior || entry.version >= prior.version) latest.set(entry.id, entry)
      }
      const keep                = []
      const activeOrDormant                = []
      for (const entry of latest.values()) {
        if (entry.status === 'tombstone') {
          // Physical deletion happens after the tombstone was recorded; the
          // tombstone itself is retained for dedupe prevention.
          keep.push(entry)
          continue
        }
        if (entry.status === 'active' && entry.expiresAt !== undefined && entry.expiresAt <= now) {
          keep.push({ ...entry, status: 'archived', updatedAt: now })
          report.expired++
          continue
        }
        if (entry.status === 'active' && now - entry.updatedAt > lifecycle.dormantDays * day && entry.recallCount === 0) {
          keep.push({ ...entry, status: 'dormant', updatedAt: now })
          report.dormant++
          continue
        }
        if (entry.status === 'dormant' && now - entry.updatedAt > lifecycle.weakRecallDays * day) {
          if (this.isProtected(entry)) {
            keep.push(entry)
            report.kept++
          } else {
            keep.push({ ...entry, status: 'archived', updatedAt: now })
            report.expired++
          }
          continue
        }
        if (entry.status === 'archived' && now - entry.updatedAt > 90 * day && !this.isProtected(entry)) {
          keep.push({ ...entry, status: 'tombstone', updatedAt: now })
          this.store.appendAudit({
            type: 'consolidate',
            actor: 'system',
            entryId: entry.id,
            layer,
            detail: 'archived -> tombstones (physical deletion after tombstone retention)',
          })
          report.deleted++
          continue
        }
        keep.push(entry)
        if (entry.status === 'active' || entry.status === 'dormant') activeOrDormant.push(entry)
      }

      // Capacity eviction: lowest value first, protected entries never evicted.
      if (activeOrDormant.length > lifecycle.capacity) {
        const sorted = activeOrDormant
          .filter((e) => !this.isProtected(e))
          .sort((a, b) => a.recallCount - b.recallCount || a.updatedAt - b.updatedAt)
        const excess = activeOrDormant.length - lifecycle.capacity
        const victimIds = new Set(sorted.slice(0, excess).map((e) => e.id))
        for (let i = 0; i < keep.length; i++) {
          const entry = keep[i]
          if (entry && victimIds.has(entry.id)) {
            keep[i] = { ...entry, status: 'archived', updatedAt: now }
            report.evicted++
          }
        }
      }
      this.store.rewriteLayer(layer, keep)
      report.kept += keep.length
    }
    this.store.appendAudit({
      type: 'consolidate',
      actor: 'system',
      detail: `expired=${report.expired} dormant=${report.dormant} evicted=${report.evicted} deleted=${report.deleted} kept=${report.kept}`,
    })
    return report
  }

          isProtected(entry             )          {
    if (this.config.lifecycle.protectedPriorities.includes(entry.priority)) return true
    return Boolean(this.config.lifecycle.userMemoryProtected && entry.source === 'user')
  }

  status(sessionId         )                     {
    const all = this.store.list()
    const current = this.findAllCurrent()
    const byStatus                         = {}
    for (const entry of current) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
    const habit = this.habitProfiles()
    const tier                = sessionId ? this.budgets.session(sessionId).tier : 'full'
    const index = planIndex(current, this.config.budget, tier)
    return {
      counts: {
        project: current.filter((e) => e.layer === 'project').length,
        global: current.filter((e) => e.layer === 'global').length,
        habit: current.filter((e) => e.layer === 'habit').length,
        total: current.length,
      },
      byStatus,
      disclosedSessions: Array.from(new Set(all.map((e) => e.lastRecalledSession).filter(Boolean))).length,
      index: { lines: index.lines.length, chars: index.chars, omitted: index.omitted, tier },
      stores: {
        project: this.store.projectRoot,
        global: this.store.globalRoot,
        habit: this.store.habitRoot,
      },
      habit: {
        profiles: habit.length,
        auto: habit.filter((h) => h.status === 'auto').length,
        suggested: habit.filter((h) => h.status === 'suggested').length,
        disabled: habit.filter((h) => h.status === 'disabled').length,
      },
    }
  }

  scopeFor(layer             )         {
    if (layer === 'project') return this.store.projectRoot ?? 'unknown-project'
    if (layer === 'global') return '__global__'
    return 'habit'
  }

  /** Habit settings are surfaced for the client review panel. */
  habitSettings()                {
    return this.config.habit
  }

  listHabitProfiles()                 {
    return this.habitProfiles()
  }

  /**
   * Materialize a habit profile into the habit layer. `suggested` profiles stay
   * dormant (never injected); only `auto` profiles become active. The status is
   * passed in by HabitEngine, which only sets `auto` after two user gates.
   */
  /**
   * Guard precheck for a habit profile.
   *
   * The pattern comes from a judge/rule over free-form user text and later
   * reaches the resident index, so it must pass the same credential scan as a
   * normal write. Returns the redacted description (line + pattern name only)
   * when a secret pattern is present.
   */
  validateHabitProfile(profile              )                                   {
    const title = `Habit · ${profile.pattern}`
    const body = `pattern: ${profile.pattern}\ncategory: ${profile.category}`
    const guard = this.guard.scan(`${title}\n${body}`)
    if (guard.ok) return { ok: true }
    const detail = this.guard.describe(guard.violations, 'habit/entries.ndjson')
    this.store.appendAudit({ type: 'write-guard-reject', actor: 'system', layer: 'habit', detail })
    return { ok: false, detail }
  }

  upsertHabitMemory(profile              )                                                                 {
    const layer              = 'habit'
    const now = this.now()
    const entries = this.store.readLayer(layer)
    const title = `Habit · ${profile.pattern}`
    const body = [
      `pattern: ${profile.pattern}`,
      `category: ${profile.category}`,
      `status: ${profile.status}`,
      `confidence: ${profile.confidence}`,
      `evidence: ${profile.evidenceCount}`,
      `sessions: ${profile.sessions.length} (${profile.sessions.join(', ')})`,
    ].join('\n')
    // Defense in depth: never persist a habit pattern that failed the scan,
    // whichever caller reached this method.
    const guarded = this.guard.scan(`${title}\n${body}`)
    if (!guarded.ok) {
      const detail = this.guard.describe(guarded.violations, 'habit/entries.ndjson')
      this.store.appendAudit({ type: 'write-guard-reject', actor: 'system', layer, detail })
      throw new GuardRejection(detail, guarded.violations)
    }
    const prior = entries
      .filter((e) => e.title.trim().toLowerCase() === title.trim().toLowerCase())
      .sort((a, b) => b.version - a.version)[0]
    const status                        = profile.status === 'auto' ? 'active' : 'dormant'
    const entry              = {
      id: prior?.id ?? shortId('habit'),
      version: prior ? prior.version + 1 : 1,
      layer,
      scope: 'habit',
      title,
      tags: ['habit', profile.status, profile.category],
      summary: `习惯：${profile.pattern}`,
      body,
      status,
      priority: profile.status === 'auto' ? 'P1' : 'P2',
      confidence: profile.confidence,
      source: 'habit',
      contentHash: fileContentHash(title, body),
      tokens: estimateTokens(body),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      recallCount: prior?.recallCount ?? 0,
      supersedes: prior?.version,
    }
    this.append(layer, entry)
    this.store.appendAudit({
      type: 'habit-candidate',
      actor: 'system',
      entryId: entry.id,
      layer,
      detail: `habit memory ${profile.status} -> ${status} (v${entry.version})`,
    })
    return { id: entry.id, version: entry.version, status }
  }

  /** Discard/delete a habit's memory record without touching project/global data. */
  disableHabitMemory(profile              )       {
    const layer              = 'habit'
    const entries = this.store.readLayer(layer)
    const title = `Habit · ${profile.pattern}`
    const prior = entries
      .filter((e) => e.title.trim().toLowerCase() === title.trim().toLowerCase())
      .sort((a, b) => b.version - a.version)[0]
    if (!prior) return
    this.append(layer, { ...prior, status: 'tombstone', updatedAt: this.now() })
    this.store.appendAudit({
      type: 'habit-delete',
      actor: 'user',
      entryId: prior.id,
      layer,
      detail: 'habit memory tombstoned (user disabled/deleted)',
    })
  }
}


//# sourceURL=memory.ts