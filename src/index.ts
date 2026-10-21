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
  // Real DSH contract (dsh-tools ToolExecutionInput): the execution carries the
  // owning `agent`, whose *id* IS the SessionId — there is no `agent.session`
  // and no top-level `session` field. Getting this wrong collapses every
  // session into one shared recall budget/disclosure bucket.
  const agentId = anyExec?.agent?.id
  const candidates = [
    anyExec?.session?.id,
    anyExec?.sessionId,
    anyExec?.context?.session?.id,
    typeof agentId === 'string' ? agentId : undefined,
    anyExec?.agent?.session?.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return 'unsessioned'
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

/**
 * Browser-origin gate for the habit mutation endpoint.
 *
 * Accepts an absent/`null` Origin (curl, some desktop shells — a cross-site
 * `fetch` cannot set `content-type: application/json` without a preflight, so
 * the content-type requirement already blocks simple-request CSRF) and any
 * origin whose host matches the request host or is a loopback name. Everything
 * else is treated as cross-site and rejected.
 */
function isSameSiteOrigin(origin: string, host: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  const originHost = parsed.host.toLowerCase()
  const requestHost = host.toLowerCase()
  if (originHost && originHost === requestHost) return true
  const hostname = parsed.hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
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

  // ---- anchor the project layer to the session's real workspace ----------
  // The Cordis process cwd is often `~` or the install directory, not the
  // repository the user opened. `Session.header.cwd` is authoritative, so the
  // first session that carries one binds the project store there (once per
  // process; later sessions share it). Best-effort: a failure leaves the
  // visible `project-layer-unavailable` health reason in place.
  ctx.on('session/event', (session: any) => {
    try {
      const header = session?.header
      const sessionCwd = header && typeof header.cwd === 'string' ? header.cwd : null
      if (sessionCwd) runtime.anchor(sessionCwd)
    } catch {
      // never let anchoring break event dispatch
    }
  })

  // ---- deterministic habit observation (zero tokens, no model call) ------
  if (cfg.habit.enabled !== false) {
    ctx.on('session/event', (session: any, event: any) => {
      if (!event || event.type !== 'user/message') return
      // Real SessionEvent envelope: { type, seq, time, data: UserMessage }.
      // Reading `event.content` (the pre-envelope shape) silently disabled
      // habit detection in production; keep the fallbacks for older hosts.
      const payload = event.data ?? event.message ?? event
      const source = payload?.source
      // Count only genuine user turns; plugin/model-sourced `user/message`
      // events (e.g. deferred tool context) must not train habits.
      if (source && typeof source === 'object' && typeof source.kind === 'string' && source.kind !== 'user') return
      const text = contentToText(payload?.content)
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
      handler: (req: any, res: any) => {
        // A store read can fail (unreadable file, EISDIR, permissions). A throw
        // here would escape the webserver request handler, so every failure is
        // turned into a visible 500 payload with the concrete reason instead.
        try {
          if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(json({ ok: false, error: 'method not allowed' }))
            return
          }
          const body = json(runtime.statusReport())
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch (error) {
          runtime.noteRecallFailure('index', 'status-route-failed', error)
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(
            json({
              ok: false,
              error: (error as Error).message,
              warning: runtime.health.warningLine(),
              health: runtime.health.snapshot(),
            }),
          )
        }
      },
    })
    register({
      kind: 'exact',
      path: '/dsh-memory/habits',
      handler: (req: any, res: any) => {
        // The mutation surface is a HUMAN gate. A browser page on another site
        // could otherwise POST here (simple-request CSRF) and promote habits,
        // so require POST + JSON + a same-site/loopback origin. Bodies are
        // capped so a hostile page cannot exhaust memory.
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(json({ ok: false, error: 'method not allowed; use POST' }))
          return
        }
        const contentType = String(req.headers?.['content-type'] ?? '')
        if (!/^application\/json\b/i.test(contentType)) {
          res.writeHead(415, { 'content-type': 'application/json' })
          res.end(json({ ok: false, error: 'content-type must be application/json' }))
          return
        }
        const origin = String(req.headers?.origin ?? '')
        const host = String(req.headers?.host ?? '')
        if (origin && origin !== 'null' && !isSameSiteOrigin(origin, host)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(json({ ok: false, error: 'cross-site request rejected' }))
          return
        }
        const MAX_BODY_BYTES = 32 * 1024
        let raw = ''
        let size = 0
        let aborted = false
        req.on('data', (chunk: any) => {
          if (aborted) return
          size += chunk?.length ?? 0
          if (size > MAX_BODY_BYTES) {
            aborted = true
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(json({ ok: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` }))
            return
          }
          raw += chunk
        })
        req.on('end', () => {
          if (aborted) return
          try {
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
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
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
          } catch (error) {
            // candidates.json is hand-editable; a malformed file must not throw
            // out of the request listener (uncaught exception) — report it.
            runtime.noteRecallFailure('habit', 'habit-route-failed', error)
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(
              json({
                ok: false,
                error: (error as Error).message,
                warning: runtime.health.warningLine(),
                health: runtime.health.snapshot(),
              }),
            )
          }
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
        priority: { type: 'string', enum: PRIORITIES, description: 'P1 important or P2 normal (default). P0 is reserved for user-authored rules and is refused from the model side.' },
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
        // P0 means "protected from the model": letting the model mint P0 entries
        // would let it create memories that neither the model nor the lifecycle
        // may ever delete. P0 is user-authored only, so refuse it here.
        if (args.priority === 'P0') {
          return {
            ok: false,
            error: 'P0 is reserved for user-authored rules; the model may write P1 or P2 memory only',
            hint: 'Record the note as P1/P2, or ask the user to promote it to P0.',
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
        'Tombstone one memory so it is never injected again. P0 and user-authored entries are PROTECTED: the model cannot force-delete them; a refusal is returned for those ids. Writes a tombstone instead of erasing history.',
      parameters: {
        id: { type: 'string', required: true, description: 'Memory id to forget.' },
        reason: { type: 'string', description: 'Why it is being forgotten (audited).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => textBlock(json(value)),
      },
      async execute(args: any) {
        if (!runtime.memory) return notReady()
        // Never expose the force override to the model: P0 rules and
        // user-authored memories must stay protected from self-service deletion.
        return runtime.memory.forget(String(args.id), 'agent', String(args.reason ?? 'forgotten'), false)
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
        // Only include keys that exist: an unavailable runtime has no cache /
        // counts / budgets, and `undefined` fields would make the JSON output
        // non-serializable (T0 caught `{"cache":undefined,...}`).
        const summary: Record<string, unknown> = {
          ok: report.ok,
          health: report.health,
          warning: report.warning,
        }
        const anyReport = report as unknown as Record<string, any>
        for (const key of ['cache', 'counts', 'budgets', 'judge'] as const) {
          if (anyReport[key] !== undefined) summary[key] = anyReport[key]
        }
        if (typeof anyReport.zeroLlm === 'boolean') summary.zeroLlm = anyReport.zeroLlm
        return summary
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
        return runtime.memory.feedback(String(args.id), args.verdict === 'wrong' ? 'wrong' : 'useful', 'agent')
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

  // Tool executions know the real session id, so they can anchor the project
  // layer too (a tool may run before/handled alongside the first session event).
  let sessionsService: any = null
  try {
    sessionsService = typeof ctx.get === 'function' ? ctx.get('sessions') ?? null : null
  } catch {
    sessionsService = null
  }
  const anchoredTools = tools.map((tool: any) => {
    const execute = tool?.execute
    if (typeof execute !== 'function') return tool
    return {
      ...tool,
      async execute(args: any, exec: ToolExec) {
        try {
          const session = sessionsService?.get?.(sessionIdOf(exec))
          const sessionCwd = session?.header?.cwd
          if (typeof sessionCwd === 'string') runtime.anchor(sessionCwd)
        } catch {
          // best-effort: the tool still runs against the current (degraded) state
        }
        return execute(args, exec)
      },
    }
  })
  for (const tool of anchoredTools) {
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
