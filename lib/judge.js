/**
 * Optional habit judge.
 *
 * One cheap model call, narrow input (<= 5 evidence slices + existing habits),
 * structured JSON output. FAIL OPEN: any error, timeout, malformed answer or
 * missing route yields `{ok:false}` and the caller keeps rule-based behavior.
 * The judge can only propose a *pending* candidate — never `auto`.
 */
                             
                    
                          
 

                               
                  
                 
                  
                    
 

                                                                                                                                    

                          
                                       
                                                 

const MAX_PATTERN = 160

export function buildJudgePrompt(input            )         {
  const evidence = input.evidence.slice(0, 5).map((e, i) => `${i + 1}. ${e.slice(0, 300)}`).join('\n')
  const habits = input.existingHabits.slice(0, 8).map((h) => `- ${h.slice(0, MAX_PATTERN)}`).join('\n') || '(none)'
  return [
    'You are a strict habit classifier. Decide whether the user repeatedly corrected the assistant in a consistent, reusable way.',
    'Reply with ONE JSON object and nothing else:',
    '{"isHabit": true|false, "pattern": "<=120 chars, imperative rule", "category": "style|workflow|tooling|format|other", "confidence": 0..1}',
    'Rules:',
    '- Corrections must describe how the assistant should behave in future work, not one-off task instructions.',
    '- If the evidence is inconsistent or too thin, set isHabit=false.',
    '- Never invent a pattern not supported by the evidence.',
    '',
    `Evidence:\n${evidence}`,
    '',
    `Existing habits:\n${habits}`,
  ].join('\n')
}

export function parseJudgeReply(raw        )                      {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed         
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed                           
  const isHabit = obj.isHabit
  const pattern = typeof obj.pattern === 'string' ? obj.pattern.trim().slice(0, MAX_PATTERN) : ''
  const category = typeof obj.category === 'string' ? obj.category.trim().slice(0, 24) : 'other'
  const confidenceRaw = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence)
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0
  if (typeof isHabit !== 'boolean') return null
  if (isHabit && pattern.length < 4) return null
  return { isHabit, pattern, category: category || 'other', confidence }
}

export class HabitJudge {
                   caller                      
                   model        
                   timeoutMs        
           enabled         

  constructor(options                                                                                       ) {
    this.caller = options.caller ?? null
    this.model = options.model
    this.timeoutMs = Math.max(200, options.timeoutMs)
    this.enabled = options.enabled && Boolean(this.caller)
  }

  async judge(input            )                        {
    if (!this.enabled || !this.caller) return { ok: false, reason: 'judge model not configured (zero-LLM mode)', failOpen: true }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const reply = await this.caller(buildJudgePrompt(input), {
        model: this.model,
        timeoutMs: this.timeoutMs,
        signal: controller.signal,
      })
      const verdict = parseJudgeReply(reply)
      if (!verdict) return { ok: false, reason: 'judge returned a malformed answer', failOpen: true }
      return { ok: true, verdict }
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : 'judge call failed'
      return { ok: false, reason, failOpen: true }
    } finally {
      clearTimeout(timer)
    }
  }
}


//# sourceURL=judge.ts