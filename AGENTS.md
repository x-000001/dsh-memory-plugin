# AGENTS.md — working in dsh-plugin-memory

Instructions for AI agents / contributors editing this repository. Keep this file accurate when the
architecture changes.

## What this repo is

A DeepSeek Harness (DSH 0.2.x) Cordis plugin bundle providing long-term memory:
four isolated stores + progressive-disclosure recall + a human-gated habit pipeline. It is **not** an
app; it is an in-process plugin loaded by the DSH Loader through `cordis.patch.yml`.

## Non-negotiable invariants

`src/invariant.ts` names them; tests enforce them. Do not regress:

1. **Store isolation** — project / global / habit roots are validated as non-nested and non-equal at
   startup; every append asserts the target layer. Cross-store writes must throw `CrossLayerWriteError`.
2. **Zero LLM** — write, recall, expand, forget, consolidate, status, feedback and the habit pipeline
   must work with no `llm` service, no vector backend and no network. The judge is optional and default
   off; a missing/broken judge must fail open (rule mode) and be visible as `degraded`, never block
   startup.
3. **Prompt-cache stability** — the injected `dsh-memory` system-prompt section must be byte-identical
   while its content signature is unchanged. Never introduce per-turn text, timestamps, counters or
   random ids into the injected block.
4. **Progressive disclosure budgets** — resident index (`indexMaxLines`, `indexMaxLineChars`,
   `indexMaxChars`) and recall (`recallMaxResults`, `recallMaxCharsPerMemory`, `recallMaxTotalChars`,
   `recallSessionBudgetChars`) are hard caps. Degradation order is fixed:
   index tier → caps → P0-only → single line. Keep it observable (`tier`, `degradationReasons`).
5. **Memory is not instruction** — the disclaimer in `src/inject.ts:12-16` must stay verbatim in the
   injected block.
6. **Write-guard** — every write path passes the deny hook first; rejections report line + pattern name
   only, never the matched value.
7. **Habit gates** — the model cannot confirm, promote, discard or delete habits. There is deliberately
   no tool parameter for mutations (only the human HTTP route). Auto requires two distinct sessions.
   Deletion writes a tombstone.
8. **Health** — state file `active | degraded | unavailable` with concrete reasons; every degradation must
   surface in the client page, `/dsh-memory/status` and the one-line prompt warning. No silent failure.
9. **Lifecycle** — everything with an OS resource is registered via `ctx.effect(...)` and disposed in
   reverse order on unload. No writes to `document.body` or the app root from the client half.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | Loader entry: exports `name`, `inject`, `apply(ctx, config)`; 8 tools, index section, `session/event` observation, optional HTTP routes |
| `src/runtime.ts` | composition root: paths, health, disclosure cache, status report |
| `src/storage.ts` | `LayeredStore`: NDJSON files, audit hash chain, root assertions, spill |
| `src/memory.ts` | write / recall / expand / forget / consolidate / feedback / promote |
| `src/habit.ts` | deterministic detection, threshold trigger, candidate zone, gates |
| `src/judge.ts` | optional judge model, strict JSON, fail open |
| `src/budget.ts` | index/recall budget ladder |
| `src/inject.ts` | injected block text, disclaimer, stable-prefix cache |
| `src/guard.ts` | credential deny rules |
| `src/health.ts` | tri-state health tracker |
| `src/tool.ts` | local `defineTool` contract (see "Deviation" in README) |
| `src/config.ts` | defaults + merge |
| `client/index.js` | Client half: `settings.section` review/status page |
| `scripts/build.mjs` | zero-dependency TS → `lib/` build (Node type stripper) |
| `scripts/typecheck.mjs` | tsc discovery + syntax-only fallback |
| `scripts/test.mjs` | per-file `node:test` launcher (sandbox-safe, sorted discovery) |
| `scripts/verify-package.mjs` | 14 pre-pack checks + credential scan (no values printed) |

`lib/` is committed build output. **Always rebuild (`pnpm build`) after editing `src/` or `client/`**
— the artifact tests load `lib/`, and the pack gate rejects stale output.

## Commands

```bash
pnpm build                    # src/ + client/ -> lib/ (also: node scripts/build.mjs; --check for CI)
pnpm typecheck                # tsc --noEmit (needs a local/global TypeScript; offline fallback available)
pnpm test                     # node scripts/test.mjs (runs tests/**/*.spec.ts)
pnpm verify                   # build --check + verify-package + tests (pre-commit and CI gate)
git config core.hooksPath .githooks   # enable pre-commit gate
```

`node tests/plugin.spec.ts` runs a single suite directly; `node --test tests/` also works outside
sandboxes that block child-process pipes.

## Conventions

* **Conventional Commits**: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
* No new runtime dependencies. The published package must have **zero** `dependencies` (the test/build
  toolchain is dev-only). No network is required at install, activation or run time.
* TypeScript is strict ESM: relative imports include `.ts` in `src/`/`tests/` (Node type stripping;
  `scripts/build.mjs` rewrites them to `.js` in `lib/`). Do not add `import type` only files that emit
  nothing when erased (interfaces live in `src/types.ts`).
* Keep `parameters` / `output.schema` / `execute` contract-correct: `execute` returns exactly the declared
  canonical JSON value, observes `exec.signal`, and never returns rendered UI.
* Every new behavior needs a test in `tests/plugin.spec.ts` (engine) or `tests/lib.spec.ts` (artifact).
* Update `README.md`, `cordis.patch.yml` defaults, `publish-status.json` and `AGENTS.md` when behavior or
  packaging changes.
* Never commit secrets, real credentials, public IPs, `*.tgz`, `node_modules/`, `.dsh/memory/`.
* Never edit the profile directory (`$DSH_HOME/profiles/...`) or hand-write profile `package.json` — install
  through the Harness plugin manager.

## Release

Tags are the only publish switch. Order is enforced by `release.yml` (tag must equal package version):

```bash
# bump version in package.json
pnpm install --lockfile-only
git add -A && git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --follow-tags
```

A missing `NPM_TOKEN` makes the Release workflow hard-fail with `::error::` **before** publish/release —
never "warn and skip". Do not create GitHub Releases by hand for untagged builds.
