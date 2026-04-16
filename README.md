# cc-tool-gate

A TypeScript HTTP server that receives Claude Code `PreToolUse` hook calls and
returns allow/deny/ask decisions. Decisions flow through a pipeline:
hard rules in `index.yaml` -> in-memory cache -> LLM (Anthropic Haiku 4.5)
judging against natural-language policies (Skill-style markdown files with YAML
frontmatter).

## Stack

- Bun + Hono + TypeScript + zod
- Anthropic SDK for LLM judging (with prompt caching)
- aws4fetch for R2 audit upload (optional)

## Status

Scaffolding only — see phase plan in repo notes.
