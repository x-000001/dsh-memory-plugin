/**
 * Configuration: defaults, normalization and the Cordis schema.
 *
 * The schema is for the Loader/settings UI; runtime code always goes through
 * `resolveConfig`, so a partial patch row (or a missing optional service) can
 * never leave the runtime without budgets.
 */
import type { BudgetSettings, MemoryPluginConfig } from './types.ts'

export const DEFAULT_BUDGET: BudgetSettings = {
  indexMaxLines: 24,
  indexMaxLineChars: 150,
  indexMaxChars: 3_000,
  recallMaxResults: 5,
  recallMaxCharsPerMemory: 1_200,
  recallMaxTotalChars: 4_000,
  recallSessionBudgetChars: 12_000,
  habitPromptMaxChars: 800,
  unloadThresholdChars: 16_000,
  degradeOrder: ['compact', 'minimal', 'single-line', 'none'],
}

export const DEFAULT_CONFIG: MemoryPluginConfig = {
  projectMemoryDir: '.dsh/memory',
  globalMemoryDir: '~/.dsh/memory',
  habitDir: '~/.dsh/storages/habit',
  budget: DEFAULT_BUDGET,
  lifecycle: {
    expireDays: 30,
    dormantDays: 14,
    weakRecallDays: 30,
    capacity: 500,
    protectedPriorities: ['P0'],
    userMemoryProtected: true,
  },
  habit: {
    enabled: true,
    threshold: 3,
    maxEvidence: 5,
    judgeEnabled: false,
    judgeTimeoutMs: 4_000,
    judgeModel: 'deepseek-chat',
    judgeProvider: '',
    minSessionsForAuto: 2,
  },
  guard: {
    extraDenyPatterns: [],
    blockEnvAssignments: true,
  },
  cacheStable: true,
  logLevel: 'info',
}

function mergeSection<T extends object>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return { ...(base as Record<string, unknown>) } as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out as T
}

/** Deep-merge the patch into defaults; unknown keys are ignored on purpose. */
export function resolveConfig(raw: Partial<MemoryPluginConfig> | undefined): MemoryPluginConfig {
  if (!raw) return structuredClone(DEFAULT_CONFIG)
  return {
    projectMemoryDir: raw.projectMemoryDir ?? DEFAULT_CONFIG.projectMemoryDir,
    globalMemoryDir: raw.globalMemoryDir ?? DEFAULT_CONFIG.globalMemoryDir,
    habitDir: raw.habitDir ?? DEFAULT_CONFIG.habitDir,
    budget: { ...mergeSection(DEFAULT_BUDGET, raw.budget), degradeOrder: [...DEFAULT_BUDGET.degradeOrder] },
    lifecycle: mergeSection(DEFAULT_CONFIG.lifecycle, raw.lifecycle),
    habit: mergeSection(DEFAULT_CONFIG.habit, raw.habit),
    guard: {
      extraDenyPatterns: raw.guard?.extraDenyPatterns ?? DEFAULT_CONFIG.guard.extraDenyPatterns,
      blockEnvAssignments: raw.guard?.blockEnvAssignments ?? DEFAULT_CONFIG.guard.blockEnvAssignments,
    },
    cacheStable: raw.cacheStable ?? DEFAULT_CONFIG.cacheStable,
    logLevel: raw.logLevel ?? DEFAULT_CONFIG.logLevel,
  }
}

