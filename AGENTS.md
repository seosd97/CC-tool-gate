# AGENTS.md

This file contains context for AI agents working on `cc-tool-gate`.

## What is this project?

`cc-tool-gate` is a small Bun/TypeScript HTTP server that acts as a **permission gate** for Claude Code's `PreToolUse` hook. When Claude Code is about to invoke a tool (e.g. `Bash`, `Edit`, `Write`), it sends an HTTP POST to this server. The server returns `allow`, `deny`, or `ask` based on:

1. Static rules in `index.yaml` (`deny`/`allow` lists by tool_name or regex pattern)
2. An in-memory LRU+TTL cache of recent decisions
3. ALL loaded natural-language policies (markdown with frontmatter) are sent to the LLM
4. An LLM judge (Anthropic) that sees every policy + the tool call
5. Fallback to the first policy's `default_decision` if the LLM fails

Every decision is logged to a daily-rotated JSONL file.

## Architecture rules

- **`core/`** — pure domain logic, no I/O. Must not import from `adapters/` or `api/`.
- **`adapters/`** — implementations of `core` interfaces. May import `core/` only.
- **`api/`** — Hono HTTP layer. May import `core/` and `adapters/`.
- **`index.ts`** — composition root: reads env, wires dependencies, exports Hono app for Bun.

## Build, test, and check commands

```sh
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Lint & format check (read-only)
bun run check

# Lint & format + auto-fix
bun run check:fix

# Start production server
bun run start

# Start dev server (auto-reload)
bun run dev
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | — | Bearer token for protected endpoints |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `POLICY_SOURCES` | Yes | — | Comma-separated `file://` URIs |
| `PORT` | No | `8787` | HTTP port |
| `HOST` | No | `127.0.0.1` | Bind interface |
| `LLM_MODEL` | No | `claude-haiku-4-5` | Anthropic model |
| `LOGS_DIR` | No | `./logs` | Audit log directory |
| `CACHE_TTL_MS` | No | `300000` | Cache TTL |
| `CACHE_MAX` | No | `2000` | Max cache entries |
| `LOG_LEVEL` | No | `info` | Pino log level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) |

## Policy file format

Policies are markdown files with YAML frontmatter:

```markdown
---
name: env-files
description: Protect .env files
default_decision: deny
---

# Body that the LLM reads

Natural-language instructions about what to allow/deny/ask.
```

- ALL loaded policies are sent to the LLM for every request (no trigger matching).
- `index.yaml` in the same directory defines `deny` and `allow` static rules.

## Key conventions

- **Zod** is used at every boundary: env vars, HTTP body, frontmatter, LLM response.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` → stop server → flush pending audit writes → exit.
- **Biome** handles linting, formatting, and import sorting. Do not add ESLint or Prettier.

## Coding patterns

### Error handling

Always use `instanceof` check, never `as` cast:

```ts
// ✅
const msg = err instanceof Error ? err.message : String(err);
// ❌
const msg = (err as Error).message;
```

### Factory functions

Use options object for 2+ parameters:

```ts
// ✅
export function createMemoryCache(opts: MemoryCacheOptions): DecisionCache { ... }
export function createLlmJudge(opts: LlmJudgeOptions): LlmJudge { ... }
// ❌ (flat params for 3 args)
export function createMemoryCache(ttlMs: number, maxEntries: number, now?: () => number): DecisionCache { ... }
```

Single-parameter factories are fine with flat params: `createPolicyStore(dirs: string[])`.

### Core purity

`core/` must not perform I/O: no `console.*`, no `fs`, no network calls.

When core needs to report issues (e.g. invalid regex), return structured data and let the adapter layer handle logging:

```ts
// core/policy.ts — returns warnings
function validatePatterns(patterns, context, warnings: ValidationWarning[]): RegExp[]
// adapters/sources.ts — logs them
for (const w of warnings) console.warn(...)
```

### Zod schema naming

Use descriptive PascalCase names, not generic names:

```ts
// ✅
const ConfigSchema = z.object({ ... });
const PermissionDecision = z.enum(["allow", "deny", "ask"]);
// ❌
const Schema = z.object({ ... });
```

### Type co-location

Types live with the module that defines the interface contract (consumer), not in a centralized `types.ts`:

- `core/gate.ts` — `DecisionResult`, `AuditRecord`, `DecisionCache`, `AuditSink`, `LlmJudge`, `GateDeps`
- `core/policy.ts` — `PermissionDecision`, `PreToolUseRequest`, `Policy`, `StaticRules`, `CompiledStaticRules`
- `config.ts` — `AppConfig`

Adapters import type from core; they never re-export or duplicate interfaces.

### Import style

- All-type import → standalone `import type { ... }`
- Mixed value + type → inline `type` qualifier

```ts
import type { AuditSink, DecisionCache, LlmJudge } from "@/core/gate";
import { type CompiledStaticRules, parsePolicy, StaticRules } from "@/core/policy";
```

### Regex pre-compilation

Compile regex once at load time (in adapters/sources via `sanitizeStaticRules`), not per-request. The compiled `CompiledStaticRules` stores `RegExp[]` instead of `string[]`. The gate uses these directly:

```ts
// sanitizeStaticRules compiles patterns → RegExp[]
// gate.ts uses them directly
rules.deny.patterns.some((rx) => rx.test(haystack))
```

### No dead code

Do not keep unused config values, env vars, or unreachable code paths. If a feature is removed, remove its config, types, and tests too.

### Decision flow

```
request → static rules (deny/allow) → cache → LLM (ALL policies) → fallback
```

- Static rules are checked first (short-circuit).
- Cache lookup uses `tool_name + JSON(tool_input)` as key.
- LLM receives every loaded policy — no trigger matching.
- On LLM failure: first policy's `default_decision`, or `"ask"` if none set.
- No policies loaded → `"allow"` with `source: "fallback"`.
