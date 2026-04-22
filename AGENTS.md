# AGENTS.md

This file contains context for AI agents working on `cc-tool-gate`.

## What is this project?

`cc-tool-gate` is a small Bun/TypeScript HTTP server that acts as a **permission gate** for Claude Code's `PreToolUse` hook. When Claude Code is about to invoke a tool (e.g. `Bash`, `Edit`, `Write`), it sends an HTTP POST to this server. The server returns `allow`, `deny`, or `ask` based on:

1. Hard rules in `index.yaml` (regex/tool-name based)
2. An in-memory LRU+TTL cache of recent decisions
3. Matched natural-language policies (markdown with frontmatter)
4. An LLM judge (Anthropic) that sees the matched policies + tool call
5. Fallback to the policy's `default_decision` if the LLM fails

Every decision is logged to a daily-rotated JSONL file.

## Architecture rules

- **`core/`** — pure domain logic, no I/O. Must not import from `adapters/` or `api/`.
- **`adapters/`** — implementations of `core/types` interfaces. May import `core/types` only.
- **`api/`** — Hono HTTP layer. May import `core/` and `adapters/`.
- **`main.ts`** — composition root: reads env, wires dependencies, starts `Bun.serve`.

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
| `RATE_LIMIT_PER_MIN` | No | `600` | Global rate limit (0 = off) |

## Policy file format

Policies are markdown files with YAML frontmatter:

```markdown
---
name: env-files
description: Protect .env files
triggers:
  tool_names: ["Bash", "Read"]
  patterns: ["\\.env"]
default_decision: deny
---

# Body that the LLM reads

Natural-language instructions about what to allow/deny/ask.
```

- `triggers` with empty `tool_names` and `patterns` are ignored (no accidental catch-alls).
- Invalid regex in `patterns` is dropped at load time with a warning.
- `index.yaml` in the same directory defines `hard_deny` and `hard_allow` rules.

## Key conventions

- **Zod** is used at every boundary: env vars, HTTP body, frontmatter, LLM response.
- **Structured logging** via `core/logger.ts` — JSON lines with `ts`, `level`, `msg`, and optional `meta`.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` → stop server → flush pending audit writes → exit.
- **Biome** handles linting, formatting, and import sorting. Do not add ESLint or Prettier.
