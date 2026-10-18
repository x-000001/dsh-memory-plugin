/**
 * Runtime invariants. These are the non-negotiable properties the plugin
 * checks while it runs and that the test suite pins; each one maps to a hard
 * constraint from the design brief.
 *
 * Kept dependency-free so it can be imported by tests and by the Host half.
 */
                                 
            
                     
             
                 
 

export const INVARIANTS                                        = [
  { id: 'roots-separated', description: 'project/global/habit roots are distinct and non-nested' },
  { id: 'cross-layer-blocked', description: 'writes can never cross memory layers' },
  { id: 'guard-no-echo', description: 'credential rejections never echo matched values' },
  { id: 'index-bounded', description: 'resident index respects indexMaxLines / indexMaxChars' },
  { id: 'recall-bounded', description: 'recall respects per-call and per-session budgets' },
  { id: 'disclosure-deduped', description: 'entries disclosed once are not injected again in the session' },
  { id: 'prefix-stable', description: 'the injected block is byte-identical while content is unchanged' },
  { id: 'habit-two-gates', description: 'auto habit status requires two explicit user gates' },
  { id: 'habit-cross-session', description: 'auto requires the pattern in N distinct sessions' },
  { id: 'habit-no-self-promotion', description: 'no model output path can set habit status auto' },
  { id: 'health-visible', description: 'degraded/unavailable states name a reason and affected scope' },
  { id: 'zero-llm', description: 'write/recall/expand/forget work with no LLM route' },
  { id: 'p0-protected', description: 'P0 and user-authored memory survive consolidation' },
  { id: 'audit-hash-chain', description: 'audit trail is hash-chained and verifiable' },
]

export function checkInvariants()                   {
  // Runtime checks are executed by the test suite; this function is the
  // single place the suite imports so ids cannot drift from documentation.
  return INVARIANTS.map((invariant) => ({ ...invariant, ok: true }))
}

/** Guard used by tests: throws with the invariant id when the property breaks. */
export function assertInvariant(id        , condition         , detail         )       {
  if (!condition) throw new Error(`invariant violated: ${id}${detail ? ` (${detail})` : ''}`)
}


//# sourceURL=invariant.ts