/**
 * write-guard: credential denylist applied to every write path.
 *
 * Contract: never echo the matched value. A rejection reports only the line
 * number and the pattern *name* (audit events, tool results, user notices).
 */
import type { GuardResult, GuardSettings, GuardViolation } from './types.ts'

export interface DenyRule {
  name: string
  pattern: RegExp
}

export const DEFAULT_DENY_RULES: DenyRule[] = [
  { name: 'openai-sk-key', pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-pat', pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/i },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'password-assignment', pattern: /\bpassword\s*[:=]\s*\S{3,}/i },
  { name: 'api-key-assignment', pattern: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*\S{6,}/i },
  { name: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
]

function compileExtra(patterns: string[]): DenyRule[] {
  const rules: DenyRule[] = []
  for (const source of patterns) {
    try {
      rules.push({ name: `custom:${source.slice(0, 24)}`, pattern: new RegExp(source) })
    } catch {
      // Invalid user regex is ignored; caller audits configuration problems.
    }
  }
  return rules
}

export class WriteGuard {
  private readonly rules: DenyRule[]
  private readonly blockEnv: boolean

  constructor(settings: Partial<GuardSettings> = {}) {
    this.rules = [...DEFAULT_DENY_RULES, ...compileExtra(settings.extraDenyPatterns ?? [])]
    this.blockEnv = settings.blockEnvAssignments !== false
  }

  /** Scan one logical content string. Only line numbers + rule names leave this method. */
  scan(content: string): GuardResult {
    const violations: GuardViolation[] = []
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      for (const rule of this.rules) {
        rule.pattern.lastIndex = 0
        if (rule.pattern.test(line)) violations.push({ line: i + 1, pattern: rule.name })
      }
      if (this.blockEnv && /(?:^|[\s;])(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*\S*[A-Za-z0-9_-]{16,}/.test(line)) {
        const value = line.split('=').slice(1).join('=')
        if (/(?:sk-|AKIA|ghp_|Bearer|password|token|secret|key)/i.test(value)) {
          violations.push({ line: i + 1, pattern: 'env-secret-assignment' })
        }
      }
    }
    return { ok: violations.length === 0, violations }
  }

  /** Human/machine safe rejection line: line numbers and pattern names only. */
  describe(violations: GuardViolation[], path: string): string {
    const parts = violations.map((v) => `line ${v.line} matched ${v.pattern}`)
    return `write-guard rejected ${path}: ${parts.join('; ')} (values are never echoed)`
  }
}
