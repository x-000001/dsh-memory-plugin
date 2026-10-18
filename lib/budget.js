/**
 * Budgets and the fixed degradation ladder.
 *
 * Order is fixed and recorded: compact -> minimal -> single-line -> none.
 * Every session carries its own spend/disclosure book, so recall is bounded
 * both per call and cumulatively, and already-disclosed entries are not
 * re-injected.
 */
             
                 
                
              
                 
                
               
                   
import { firstSentence } from './types.js'

                                       
                  
                      
                  
                             
 

                                        
                    
                           
                       
 

const TIER_LADDER                  = ['compact', 'minimal', 'single-line', 'none']

export class SessionBudget {
           sessionId        
  spentChars = 0
  disclosed = new Set        ()
  tier                = 'full'
  reasons           = []
           budgetChars        

  constructor(sessionId        , budgetChars        ) {
    this.sessionId = sessionId
    this.budgetChars = budgetChars
  }

  degrade(reason        , order                 )       {
    if (!this.reasons.includes(reason)) this.reasons.push(reason)
    const ladder = order.length ? order : TIER_LADDER
    const current = ladder.indexOf(this.tier)
    const next = ladder[Math.min(current === -1 ? 0 : current + 1, ladder.length - 1)] ?? 'none'
    this.tier = this.tier === 'full' ? ladder[0] ?? 'compact' : next
  }

  remaining()         {
    return Math.max(0, this.budgetChars - this.spentChars)
  }
}

export class BudgetBook {
                   settings                
                   sessions = new Map                       ()

  constructor(settings                ) {
    this.settings = settings
  }

  session(sessionId        )                {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = new SessionBudget(sessionId, this.settings.recallSessionBudgetChars)
      this.sessions.set(sessionId, state)
    }
    return state
  }

  reset(sessionId        )       {
    this.sessions.delete(sessionId)
  }

  get order()                  {
    return this.settings.degradeOrder.length ? this.settings.degradeOrder : [...TIER_LADDER]
  }
}

export function indexLimitsFor(settings                , tier               )                       {
  const factors                                = { full: 1, compact: 0.75, minimal: 0.5, 'single-line': 0, none: 0 }
  const factor = factors[tier]
  if (tier === 'single-line') {
    // Last line of defence: one deterministic index line, even for P2 entries.
    // The +1 leaves room for the newline accounted for by planIndex.
    return { maxLines: 1, maxLineChars: settings.indexMaxLineChars, maxChars: settings.indexMaxLineChars + 1, minPriority: 'P2' }
  }
  return {
    maxLines: Math.max(0, Math.floor(settings.indexMaxLines * factor)),
    maxLineChars: settings.indexMaxLineChars,
    maxChars: Math.max(0, Math.floor(settings.indexMaxChars * factor)),
    minPriority: tier === 'minimal' ? 'P1' : 'P2',
  }
}

export function recallLimitsFor(settings                , tier               )                        {
  const base = {
    maxResults: settings.recallMaxResults,
    maxCharsPerMemory: settings.recallMaxCharsPerMemory,
    maxTotalChars: settings.recallMaxTotalChars,
  }
  switch (tier) {
    case 'full':
      return base
    case 'compact':
      return {
        maxResults: Math.max(1, base.maxResults - 1),
        maxCharsPerMemory: Math.floor(base.maxCharsPerMemory * 0.75),
        maxTotalChars: Math.floor(base.maxTotalChars * 0.75),
      }
    case 'minimal':
      return {
        maxResults: Math.min(2, base.maxResults),
        maxCharsPerMemory: Math.min(400, base.maxCharsPerMemory),
        maxTotalChars: Math.floor(base.maxTotalChars * 0.4),
      }
    default:
      return { maxResults: 1, maxCharsPerMemory: 240, maxTotalChars: Math.min(500, base.maxTotalChars) }
  }
}

const PRIORITY_RANK                                 = { P0: 3, P1: 2, P2: 1 }

export function priorityAtLeast(priority                , min                )          {
  return PRIORITY_RANK[priority] >= PRIORITY_RANK[min]
}

/** One index line: never longer than `maxLineChars`; contains no body text. */
export function formatIndexLine(entry             , maxLineChars        )         {
  const head = `- [${entry.priority}] ${entry.priority === 'P0' ? '★' : ''}${entry.id} ${entry.title} (${entry.layer})`
  const tags = entry.tags.length ? ` tags:${entry.tags.slice(0, 3).join(',')}` : ''
  const summary = firstSentence(entry.summary || entry.body, Math.max(20, maxLineChars - head.length - tags.length - 3))
  const line = `${head}${tags} :: ${summary}`
  return line.length > maxLineChars ? `${line.slice(0, Math.max(0, maxLineChars - 3))}...` : line
}

                            
                 
               
                 
                     
 

/**
 * Deterministic index: order = priority desc, then createdAt asc, then id.
 * Keeping the order and content stable is what makes the injected prefix
 * byte-identical across turns.
 */
export function planIndex(
  entries               ,
  settings                ,
  tier               ,
)            {
  const limits = indexLimitsFor(settings, tier)
  if (limits.maxLines === 0) return { lines: [], chars: 0, omitted: entries.length, tier }
  const active = entries
    .filter((e) => e.status === 'active')
    .filter((e) => priorityAtLeast(e.priority, limits.minPriority))
    .sort((a, b) => {
      const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
      if (p !== 0) return p
      const t = a.createdAt - b.createdAt
      return t !== 0 ? t : a.id.localeCompare(b.id)
    })
  const lines           = []
  let chars = 0
  let omitted = 0
  for (const entry of active) {
    if (lines.length >= limits.maxLines) {
      omitted++
      continue
    }
    const line = formatIndexLine(entry, limits.maxLineChars)
    if (chars + line.length + 1 > limits.maxChars) {
      omitted++
      continue
    }
    lines.push(line)
    chars += line.length + 1
  }
  return { lines, chars, omitted, tier }
}

export function recallBudgetSummary(settings                , session               )               {
  return {
    items: [],
    tier: session.tier,
    degraded: session.tier !== 'full',
    degradationReasons: session.reasons,
    spentChars: 0,
    sessionSpentChars: session.spentChars,
    sessionBudgetChars: session.budgetChars,
    dedupedIds: [],
    hint: session.tier === 'none' ? 'recall surface exhausted; use memory_expand with an explicit id' : '',
  }
}

export function clampRecallOptions(options               , settings                )                {
  return {
    ...options,
    maxResults: Math.max(1, Math.min(options.maxResults ?? settings.recallMaxResults, settings.recallMaxResults)),
    maxCharsPerMemory: Math.max(
      80,
      Math.min(options.maxCharsPerMemory ?? settings.recallMaxCharsPerMemory, settings.recallMaxCharsPerMemory),
    ),
    maxTotalRecallChars: Math.max(
      200,
      Math.min(options.maxTotalRecallChars ?? settings.recallMaxTotalChars, settings.recallMaxTotalChars),
    ),
  }
}


//# sourceURL=budget.ts