# cc-tool-gate

A small TypeScript HTTP server that receives Claude Code `PreToolUse` hook
calls and returns `allow` / `deny` / `ask` decisions. Decisions flow through a
pipeline:

1. Hard rules in `index.yaml` (deny / allow lists).
2. In-memory LRU+TTL cache of recent decisions.
3. Trigger match against natural-language policies (Skill-style markdown).
4. LLM judge (Anthropic Haiku 4.5) — sees the matched policies and the tool
   call, returns one-line JSON.
5. On LLM failure, falls back to the matched policy's `default_decision`,
   else `ask`.

Every decision is appended to a local JSONL file. If the optional R2 vars are
set, rotated `.jsonl.gz` files are uploaded in the background.

## Stack

- Bun 1.3+ runtime
- Hono for the HTTP server
- zod at every boundary (env, HTTP body, frontmatter, source bytes)
- `@anthropic-ai/sdk` with prompt caching on the policies block
- `gray-matter` + `yaml` for policy parsing
- `aws4fetch` for the R2 PUT (S3-compatible)

## Install & run

```sh
bun install
cp .env.example .env       # then fill in AUTH_TOKEN, ANTHROPIC_API_KEY, ...
bun run start              # production
bun run dev                # auto-restart on changes
bun test                   # 50 tests, all green
```

## Configuration

Required:

| Var | Purpose |
| --- | --- |
| `AUTH_TOKEN` | Bearer token required on `/v1/pretooluse` and `/admin/reload`. |
| `ANTHROPIC_API_KEY` | Anthropic API key for the LLM judge. |
| `POLICY_SOURCES` | Comma-separated list of source URIs (see below). |

Optional:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. |
| `LLM_MODEL` | `claude-haiku-4-5` | Anthropic model. |
| `LOGS_DIR` | `./logs` | Where to write JSONL audit logs. |
| `HOSTNAME` | `os.hostname()` | Logical host name (used in R2 key). |
| `CACHE_TTL_MS` | `300000` | Decision cache TTL. |
| `CACHE_MAX` | `2000` | Max cached decisions. |
| `POLICY_POLL_MS` | `60000` | Source poll interval. |
| `R2_POLL_MS` | `30000` | R2 upload tick. |
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET` | (none) | All four required to enable R2 upload. If any is missing, audit stays local only. |

## Policy sources

`POLICY_SOURCES` is a comma-separated list of URIs. Later sources override
earlier sources by `name` (frontmatter).

- `file:///abs/path/to/policies` — directory of `*.md` policy files plus
  optional `index.yaml`.
- `https://host/path/manifest.json` — JSON of the form
  `{"policies":[{"name":"x","url":"https://..."}], "index":"https://..."}`.
- `https://host/path/policy.md` — single markdown file.
- `inline:base64(...)` — one inline policy, base64-encoded markdown.

Reload at runtime with `POST /admin/reload` (bearer-protected) or wait for the
poll interval.

## Policy file format

```markdown
---
name: env-files
description: Protect .env files and credentials.
triggers:
  tool_names: ["Bash", "Edit", "Write", "Read"]
  patterns: ["\\.env", "credentials", "secrets/"]
default_decision: deny
---

# Body that the LLM reads

Natural-language explanation of what to allow / deny / ask.
The LLM is told the body verbatim plus the tool call, and replies with
one line of JSON: {"decision":"allow|deny|ask","reason":"..."}.
```

A policy is *considered* (passed to the LLM) only if its triggers match. A
policy with no triggers at all is ignored — that prevents accidental
catch-alls.

The bundled `policies/` directory has four working examples
(`env-files`, `destructive-bash`, `git-operations`, `package-install`)
plus an `index.yaml` of hard-deny patterns for the truly catastrophic
commands (`rm -rf /`, fork bombs, `mkfs.*`, `dd if=...of=/dev/sd*`).

## HTTP API

### `GET /health`

Public. Returns `{ ok: true, policies: <count>, cache_size: <n> }`.

### `POST /v1/pretooluse`

Bearer-protected. Body matches Claude Code's PreToolUse hook input:

```json
{
  "session_id": "abc",
  "cwd": "/some/path",
  "hook_event_name": "PreToolUse",
  "permission_mode": "default",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf node_modules" }
}
```

Response (matches Claude Code's expected schema):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "deletes node_modules inside the project"
  }
}
```

### `POST /admin/reload`

Bearer-protected. Triggers an immediate reload of all sources and reports
the new policy count.

## Wiring into Claude Code

Add an HTTP-style PreToolUse hook to your Claude Code `settings.json`. The
exact field names follow Claude Code's hook spec; consult its docs for the
authoritative shape. A typical entry looks like:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "http",
        "url": "http://127.0.0.1:8787/v1/pretooluse",
        "headers": {
          "Authorization": "Bearer ${CC_TOOL_GATE_TOKEN}"
        },
        "timeout_ms": 5000
      }
    ]
  }
}
```

Set `CC_TOOL_GATE_TOKEN` in your shell to the same value as the server's
`AUTH_TOKEN`.

## Adding a policy

1. Create a new markdown file under your `POLICY_SOURCES` directory.
2. Give it a unique `name`, a short `description`, and `triggers` so the
   policy actually fires for the relevant tool calls.
3. In the body, write — in plain English — what to allow, what to deny,
   and what to ask about. The LLM is only as good as your description.
4. Set a sensible `default_decision`; this is what the gate returns when
   the LLM call times out or returns a malformed answer.
5. `POST /admin/reload` (or wait for the poll interval).

## Audit logs

- Live writes go to `${LOGS_DIR}/current.jsonl` (one JSON object per line).
- Rotation: `60s` OR `5MB`, whichever comes first. The rotated file is
  gzipped and moved to `${LOGS_DIR}/pending/`.
- If R2 is enabled, the background worker uploads `pending/*.jsonl.gz`,
  moves them to `uploaded/`, and deletes uploaded files older than 7 days.
- R2 key layout:
  `decisions/dt=YYYY-MM-DD/host=${HOSTNAME}/<unix>-<rand4>.jsonl.gz`.

## Repository layout

```
src/
  main.ts             composition root: env -> wire deps -> Bun.serve
  config.ts           env var parsing (zod)
  core/               domain logic (no IO)
    types.ts          zod schemas + interfaces
    pipeline.ts       hard rules -> cache -> LLM
    policy.ts         frontmatter parse + trigger match
  adapters/           implementations of core/types interfaces
    cache.ts          LRU + TTL
    llm.ts            Anthropic SDK with prompt caching
    jsonl.ts          local append + rotate + gzip
    r2.ts             aws4fetch upload worker
    sources.ts        file:// / https:// / inline:
  api/
    app.ts            Hono app factory
tests/                bun:test, mirrors src layout
policies/             default policy bundle + index.yaml
```

`core/` does not import from `adapters/` or `api/`. `adapters/` imports
only `core/types`. `api/` imports `core/`. `main.ts` wires everything.
