/**
 * Host half of dsh-plugin-memory.
 *
 * Loader entry: this module is imported in-process by the Cordis Loader; it
 * exports `name`, `inject` and `apply(ctx, config)`. Optional services
 * (`systemPrompt`, `llm`, `webServer`) are obtained through `ctx.inject` /
 * guarded `ctx.get`, so the plugin stays fully functional — and never blocks
 * DSH startup — when they are absent.
 *
 * Zero-LLM is first class: every tool below works with no `llm` route. The
 * only model call in the whole plugin is the optional habit judge (default
 * off) and it fails open.
 */
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './config.ts'
import { MemoryRuntime } from './runtime.ts'
import { defineTool, textBlock, type ToolExec } from './tool.ts'
import { GuardRejection } from './memory.ts'
import type { MemoryLayer, MemoryPluginConfig, MemoryPriority } from './types.ts'

export const name = 'dsh-memory'

/** Host services this plugin cannot run without. Everything else is optional. */
export const inject = ['tools']

const MEMORY_LAYERS = ['project', 'global'] as const
const PRIORITIES = ['P0', 'P1', 'P2'] as const

/** Session id from the tool execution context, falling back to a process key. */
function sessionIdOf(exec: ToolExec | undefined): string {
  const anyExec = exec as unknown as Record<string, any>
  return (
    anyExec?.session?.id ??
    anyExec?.sessionId ??
    anyExec?.context?.session?.id ??
    anyExec?.agent?.session?.id ??
    'unsessioned'
  )
}

/** Flatten ContentBlock[] (or a string) from a session/tool event to text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const anyBlock = block as Record<string, any>
    if (typeof anyBlock.text === 'string') parts.push(anyBlock.text)
    else if (typeof anyBlock.content === 'string') parts.push(anyBlock.content)
  }
  return parts.join('\n')
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * Resolve the project directory the plugin should anchor project memory to.
 *
 * Cordis proxies every context property through its service registry and throws
 * `cannot get property "<name>" without inject` for undeclared properties; a
 * real activation failure was observed in DSH 0.2.0-rc.1 when reading
 * `ctx.baseDir` bare. Every probe below therefore runs inside its own try/catch
 * and the plugin always falls back to `process.cwd()`.
 */
function safeProperty(scope: any, name: string): unknown {
  try {
    return scope?.[name]
  } catch {
    return undefined
  }
}

function resolveCwd(ctx: any): string {
  const root = safeProperty(ctx, 'root')
  for (const scope of [ctx, root]) {
    for (const key of ['baseDir', 'cwd']) {
      const dir = safeProperty(scope, key)
      if (typeof dir === 'string' && dir.length > 0) return dir
    }
    const baseUrl = safeProperty(scope, 'baseUrl')
    if (typeof baseUrl === 'string' && baseUrl.startsWith('file:')) {
      try {
        return fileURLToPath(baseUrl)
      } catch {
        // malformed baseUrl; fall through
      }
    }
  }
  return process.cwd()
}

export function apply(ctx: any, config: unknown): void {
  const cwd = resolveCwd(ctx)
  const cfg = resolveConfig(config as Partial<MemoryPluginConfig> | undefined)

  // ---- optional LLM caller for the habit judge (never required) ------------
  let llm: any = null
  try {
    llm = typeof ctx.get === 'function' ? ctx.get('llm') ?? null : null
  } catch {
    llm = null
  }
  const resolved = resolveJudgeRoute(config)
  const llmCaller =
    llm && resolved.provider && resolved.model
      ? async (prompt: string, options: { model: string; timeoutMs: number; signal?: AbortSignal }) => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), options.timeoutMs)
          const onAbort = () => controller.abort()
          options.signal?.addEventListener('abort', onAbort, { once: true })
          let text = ''
          try {
            const stream = llm.stream({
              provider: resolved.provider,
              model: options.model || resolved.model,
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
              temperature: 0,
              maxTokens: 160,
              signal: controller.signal,
              purpose: 'session-title',
            })
            for await (const chunk of stream as AsyncIterable<any>) {
              if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            }
            return text
          } finally {
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
          }
        }
      : null

  const runtime = new MemoryRuntime({ cwd, config: cfg, llmCaller })

  // ---- lifecycle: dispose the runtime when the plugin unloads -------------
  ctx.effect(() => () => runtime.dispose(), 'dsh-memory: runtime dispose')

  // ---- resident index section (byte-stable while content is unchanged) ----
  ctx.inject(['systemPrompt'], (promptCtx: any) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'dsh-memory',
          order: 40,
          // Function form: rendered from the cached disclosure block. Its
          // bytes only change when the index signature changes (new write,
          // forget, consolidation or a health transition) — this is the
          // prompt-cache stability contract.
          text: () => runtime.refresh().text,
          interpolate: false,
        }),
      'dsh-memory: index section',
    )
  })

  // ---- deterministic habit observation (zero tokens, no model call) ------
  if (cfg.habit.enabled !== false) {
    ctx.on('session/event', (session: any, event: any) => {
      if (!event || event.type !== 'user/message') return
      const text = contentToText(event.content ?? event.message?.content)
      if (!text.trim()) return
      const habit = runtime.habit
      if (!habit) return
      const sessionId = String(session?.id ?? event.sessionId ?? 'unknown')
      const turn = Number(event.turn ?? 0)
      void habit
        .observe(sessionId, turn, text)
        .catch((error: unknown) => runtime.noteRecallFailure('habit', 'observe-failed', error))
    })
  }

  // ---- optional read-only HTTP surface (settings panel / external tools) --
  ctx.inject(['webServer'], (webCtx: any) => {
    const register = (route: Record<string, unknown>) => {
      try {
        webCtx.effect(() => webCtx.webServer.register(route), `dsh-memory: ${String(route.path)}`)
      } catch (error) {
        runtime.noteRecallFailure('index', 'http-route-failed', error)
      }
    }
    register({
      kind: 'exact',
      path: '/dsh-memory/status',
      handler: (_req: any, res: any) => {
        const body = json(runtime.statusReport())
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
      },
    })
    register({
      kind: 'exact',
      path: '/dsh-memory/habits',
      handler: (req: any, res: any) => {
        let raw = ''
        req.on('data', (chunk: any) => {
          raw += chunk
        })
        req.on('end', () => {
          let action = 'list'
          let id = ''
          try {
            const parsed = raw ? JSON.parse(raw) : {}
            action = String(parsed.action ?? 'list')
            id = String(parsed.id ?? '')
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(json({ ok: false, error: 'invalid JSON body' }))
            return
          }
          const habit = runtime.habit
          if (!habit) {
            res.writeHead(503, { 'content-type': 'application/json' })
            res.end(json({ ok: false, warning: runtime.health.warningLine(), health: runtime.health.snapshot() }))
            return
          }
          if (action === 'list') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(json({ ok: true, ...habit.review(), profiles: runtime.profiles() }))
            return
          }
          // Every mutation route is a human gate: only a user-originated
          // request may confirm/promote/delete. There is deliberately no
          // model-callable promotion path.
          const result =
            action === 'confirm'
              ? habit.confirm(id, 'user')
              : action === 'promote'
                ? habit.promote(id, 'user')
                : action === 'discard'
                  ? habit.discard(id, 'user')
                  : action === 'delete'
                    ? habit.deleteProfile(id, 'user')
                    : { ok: false, reason: `unknown action: ${action}` }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(json({ ok: true, result }))
        })
      },
    })
  })

  // ------------------------------- tools ---------------------------------
  const notReady = () => ({
    ok: false,
    error: 'memory runtime unavailable',
    warning: runtime.health.warningLine(),
    health: runtime.health.snapshot(),
  })

  const tools = [
    defineTool({
      name: 'memory_remember',
      description:
        'Persist one durable memory entry into the project store or the global store. Use it when the user states a lasting preference, fact or decision worth carrying to future sessions. Content is scanned by the write-guard: secrets are rejected (line + pattern name only, the value is never echoed). Project and global roots are strictly isolated; promoting a project memory to global requires an explicit user instruction (layer="global" plus confirmed=true).',
      parameters: {
        content: { type: 'string', required: true, description: 'The fact/preference to remember. Markdown is allowed.' },
        title: { type: 'string', required: true, description: 'Short stable title used in the resident index (<=120 chars).' },
        summary: { type: 'string', description: 'One-sentence summary shown by memory_recall.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Retrieval tags, e.g. ["style","testing"].' },
        layer: { type: 'string', enum: MEMORY_LAYERS, description: 'project (default) or global. habit entries are gated by memory_habits only.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'P0 protected, P1 important, P2 normal (default).' },
        confirmed: { type: 'boolean', description: 'Required true when writing global memory from a project source.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any, exec: ToolExec) {
        if (!runtime.memory) return notReady()
        const layer: MemoryLayer = args.layer === 'global' ? 'global' : 'project'
        if (layer === 'global' && args.confirmed !== true) {
          return {
            ok: false,
            error: 'global write requires explicit user confirmation (confirmed=true)',
            hint: 'Ask the user first; memory files are context, not permission.',
          }
        }
        try {
          const result = runtime.memory.write(
            {
              title: args.title,
              summary: args.summary,
              body: args.content,
              tags: Array.isArray(args.tags) ? args.tags : [],
              priority: (args.priority as MemoryPriority) ?? 'P2',
              source: 'auto',
            },
            layer,
            'agent',
            sessionIdOf(exec),
          )
          runtime.noteWriteOk()
          return { ok: true, ...result, layer }
        } catch (error) {
          if (error instanceof GuardRejection) {
            runtime.noteGuardRejection(error)
            return {
              ok: false,
              error: 'write-guard rejected the content (values not echoed)',
              violations: error.violations,
              warning: runtime.health.warningLine(),
            }
          }
          runtime.noteRecallFailure('write', 'write-failed', error)
          return { ok: false, error: (error as Error).message, warning: runtime.health.warningLine() }
        }
      },
    }),

    defineTool({
      name: 'memory_recall',
      description:
        'Retrieve memory bodies matching a query with progressive disclosure and hard budgets (maxResults / per-entry chars / total chars / per-session cumulative budget). Entries already disclosed in this session are de-duplicated unless allowRepeat=true. Returns a degradation tier when budgets are tight. Works with keyword relevance only — no LLM required.',
      parameters: {
        query: { type: 'string', required: true, description: 'What to look for (natural language or keywords).' },
        layer: { type: 'string', enum: MEMORY_LAYERS, description: 'Restrict to one layer; omit for all.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter.' },
        maxResults: { type: 'number', description: 'Top-K cap for this call.' },
        maxCharsPerMemory: { type: 'number', description: 'Body cap per item.' },
        maxTotalRecallChars: { type: 'number', description: 'Total chars injected by this call.' },
        allowRepeat: { type: 'boolean', description: 'Re-disclose entries already seen this session.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any, exec: ToolExec) {
        if (!runtime.memory) return notReady()
        try {
          const result = runtime.memory.recall({
            sessionId: sessionIdOf(exec),
            query: String(args.query ?? ''),
            layer: args.layer === 'global' ? 'global' : args.layer === 'project' ? 'project' : undefined,
            tags: Array.isArray(args.tags) ? args.tags : undefined,
            maxResults: args.maxResults,
            maxCharsPerMemory: args.maxCharsPerMemory,
            maxTotalRecallChars: args.maxTotalRecallChars,
            allowRepeat: args.allowRepeat === true,
          })
          return result
        } catch (error) {
          runtime.noteRecallFailure('recall', 'recall-failed', error)
          return { ok: false, error: (error as Error).message, warning: runtime.health.warningLine() }
        }
      },
    }),

    defineTool({
      name: 'memory_expand',
      description:
        'Load the full body of one memory by id (bypassing the compact recall excerpt), up to a hard character cap. Use after memory_recall when the excerpt is insufficient. Audited.',
      parameters: {
        id: { type: 'string', required: true, description: 'Memory id from the index or a recall result.' },
        maxChars: { type: 'number', description: 'Hard cap for the returned body.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any, exec: ToolExec) {
        if (!runtime.memory) return notReady()
        const result = runtime.memory.expand(String(args.id), sessionIdOf(exec), args.maxChars)
        if (!result.found) return { ok: false, error: `memory not found: ${args.id}` }
        return { ok: true, ...result }
      },
    }),

    defineTool({
      name: 'memory_forget',
      description:
        'Tombstone one memory so it is never injected again. P0 and user-authored entries are protected unless force=true. Writes a tombstone instead of erasing history.',
      parameters: {
        id: { type: 'string', required: true, description: 'Memory id to forget.' },
        reason: { type: 'string', description: 'Why it is being forgotten (audited).' },
        force: { type: 'boolean', description: 'Override P0/user protection.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any) {
        if (!runtime.memory) return notReady()
        return runtime.memory.forget(String(args.id), 'agent', String(args.reason ?? 'forgotten'), args.force === true)
      },
    }),

    defineTool({
      name: 'memory_consolidate',
      description:
        'Run the lifecycle chain synchronously: expire -> dormant -> weak renewal -> capacity eviction -> physical deletion. P0 and user-authored memories are protected. Merge/compress work stays in the background path; this call is the explicit maintenance entry point.',
      parameters: {
        dryRun: { type: 'boolean', description: 'Compute the plan without mutating stores.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any) {
        if (!runtime.memory) return notReady()
        if (args.dryRun === true) {
          return { ok: true, dryRun: true, counts: runtime.memory.status().counts }
        }
        return { ok: true, ...runtime.memory.consolidate() }
      },
    }),

    defineTool({
      name: 'memory_status',
      description:
        'Report memory health (active/degraded/unavailable with concrete reasons and affected features), per-layer counts, configured budgets, judge state, and the current disclosure cache hash/tier. Use it to verify zero-LLM operation and prefix stability.',
      parameters: {
        verbose: { type: 'boolean', description: 'Include per-layer paths and index plan.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any, exec: ToolExec) {
        const report = runtime.statusReport(sessionIdOf(exec))
        if (args.verbose === true) return report
        return {
          ok: report.ok,
          health: report.health,
          warning: report.warning,
          cache: report.cache,
          counts: report.counts,
          budgets: report.budgets,
          judge: report.judge,
          zeroLlm: report.zeroLlm,
        }
      },
    }),

    defineTool({
      name: 'memory_feedback',
      description:
        'Give recall feedback for one memory: "useful" raises confidence, "wrong" lowers it and flags the entry for review. Deterministic, no model call.',
      parameters: {
        id: { type: 'string', required: true, description: 'Memory id.' },
        verdict: { type: 'string', required: true, enum: ['useful', 'wrong'], description: 'Feedback signal.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any) {
        if (!runtime.memory) return notReady()
        return runtime.memory.feedback(String(args.id), args.verdict === 'wrong' ? 'wrong' : 'useful', 'user')
      },
    }),

    defineTool({
      name: 'memory_habits',
      description:
        'Read-only audit of the habit pipeline: pending candidates, habit profiles (suggested = gate 1 passed but not injected, auto = injected), tombstones, thresholds and the two human gates. Mutations are intentionally NOT exposed as tools: confirming, promoting, discarding and deleting habits happen only through the human UI (/dsh-memory/habits), so a model can never promote a habit by itself.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute() {
        const habit = runtime.habit
        if (!habit) return notReady()
        return { ok: true, ...habit.review(), profiles: runtime.profiles(), mutations: 'human UI only: GET/POST /dsh-memory/habits' }
      },
    }),
  ]

  for (const tool of tools) {
    ctx.tools.register(tool)
  }

  // Ensure a status endpoint exists even if webServer arrives later.
  if (!runtime.available) {
    runtime.noteWarning()
  }
}

function resolveJudgeRoute(config: any): { provider: string; model: string } {
  return {
    provider: String(config?.habit?.judgeProvider ?? ''),
    model: String(config?.habit?.judgeModel ?? ''),
  }
}
