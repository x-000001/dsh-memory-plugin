/**
 * Test harness: isolated filesystem (temp dir), fake project roots and a
 * controllable judge/LLM caller. No network, no external services.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryRuntime } from '../src/runtime.ts'
import type { LlmTextCaller } from '../src/judge.ts'
import type { MemoryPluginConfig } from '../src/types.ts'

export interface HarnessOptions {
  /** Partial plugin config, deep-merged against defaults by the runtime. */
  config?: Partial<MemoryPluginConfig>
  /** Fake LLM caller for the habit judge. Omit for zero-LLM runs. */
  llmCaller?: LlmTextCaller | null
  /** Run the runtime in project B instead of project A. */
  project?: 'a' | 'b'
}

export interface Harness {
  root: string
  dshHome: string
  projectA: string
  projectB: string
  runtime: MemoryRuntime
  /** Open a second runtime over the same DSH_HOME (durability/rollback tests). */
  open(project?: 'a' | 'b', overrides?: Partial<HarnessOptions>): MemoryRuntime
  readHealthFile(): Record<string, any>
  cleanup(): void
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const dshHome = join(root, 'dsh-home')
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  for (const project of [projectA, projectB]) {
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(join(project, 'src'), { recursive: true })
  }

  const open = (project: 'a' | 'b' = 'a', overrides: Partial<HarnessOptions> = {}): MemoryRuntime =>
    new MemoryRuntime({
      cwd: project === 'a' ? projectA : projectB,
      dshHome,
      config: (overrides.config ?? options.config) as Partial<MemoryPluginConfig> | undefined,
      llmCaller: overrides.llmCaller !== undefined ? overrides.llmCaller : (options.llmCaller ?? null),
    })

  return {
    root,
    dshHome,
    projectA,
    projectB,
    runtime: open(options.project ?? 'a'),
    open,
    readHealthFile() {
      const file = join(dshHome, 'storages', 'memory', 'health.json')
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Counted fake judge; replies with one JSON object. */
export function fakeJudge(reply: unknown): { caller: LlmTextCaller; calls: () => number; prompts: string[] } {
  let calls = 0
  const prompts: string[] = []
  const caller: LlmTextCaller = async (prompt) => {
    calls += 1
    prompts.push(prompt)
    return typeof reply === 'string' ? reply : JSON.stringify(reply)
  }
  return { caller, calls: () => calls, prompts }
}

/** Fake judge that always fails (timeout/unavailable => fail open). */
export function failingJudge(message = 'judge timeout'): { caller: LlmTextCaller; calls: () => number } {
  let calls = 0
  const caller: LlmTextCaller = async () => {
    calls += 1
    throw new Error(message)
  }
  return { caller, calls: () => calls }
}

/** Valid judge verdict for a stable habit. */
export const HABIT_VERDICT = {
  isHabit: true,
  pattern: 'prefer tabs over spaces',
  category: 'style',
  confidence: 0.86,
}

/** Feed `count` correction messages into one session (one signal each). */
export async function feedCorrections(
  runtime: MemoryRuntime,
  sessionId: string,
  count = 3,
  texts: string[] = [],
): Promise<void> {
  const habit = runtime.require().habit
  const fallback = ['不对，应该用 tabs。', '不是这样，我说的是 rtk。', '你理解错了，别再用 --json。']
  for (let index = 0; index < count; index += 1) {
    await habit.observe(sessionId, index + 1, texts[index] ?? fallback[index % fallback.length])
  }
}
