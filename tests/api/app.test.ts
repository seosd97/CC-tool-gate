import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/api/app";
import type {
  AuditRecord,
  AuditSink,
  DecisionCache,
  DecisionResult,
  IndexConfig,
  LlmJudge,
  Policy,
} from "../../src/core/types";

const TOKEN = "secret-token";

const baseIndex: IndexConfig = {
  hard_deny: { tool_names: [], patterns: [] },
  hard_allow: { tool_names: [], patterns: [] },
};

function deps(over: {
  llm?: LlmJudge;
  policies?: Policy[];
  index?: IndexConfig;
  cache?: DecisionCache;
  sink?: AuditSink;
  reload?: () => Promise<void>;
} = {}) {
  const cache: DecisionCache = over.cache ?? {
    _store: new Map<string, DecisionResult>(),
    get() {
      return undefined;
    },
    set() {},
    size() {
      return 0;
    },
  } as any;
  const sink: AuditSink = over.sink ?? { write: async () => {} };
  return {
    authToken: TOKEN,
    llm:
      over.llm ?? {
        judge: async () => ({ decision: "allow" as const, reason: "ok" }),
      },
    cache,
    sink,
    getSnapshot: () => ({ policies: over.policies ?? [], index: over.index ?? baseIndex }),
    reload: over.reload ?? (async () => {}),
  };
}

const REQ_BODY = {
  session_id: "s",
  cwd: "/c",
  hook_event_name: "PreToolUse",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "ls" },
};

describe("api app", () => {
  test("GET /health is unauthenticated", async () => {
    const app = createApp(deps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /v1/pretooluse rejects without bearer token", async () => {
    const app = createApp(deps());
    const res = await app.request("/v1/pretooluse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(401);
  });

  test("POST /v1/pretooluse returns Claude Code-spec JSON", async () => {
    const app = createApp(
      deps({
        policies: [
          {
            name: "p",
            description: "",
            triggers: { tool_names: ["Bash"], patterns: [".*"] },
            default_decision: "ask",
            body: "",
            source: "x",
          },
        ],
        llm: {
          judge: async () => ({ decision: "deny", reason: "blocked" }),
        },
      }),
    );
    const res = await app.request("/v1/pretooluse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(REQ_BODY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    });
  });

  test("POST /v1/pretooluse 400 on bad body", async () => {
    const app = createApp(deps());
    const res = await app.request("/v1/pretooluse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ wrong: "shape" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /admin/reload calls reload and reports policy count", async () => {
    let called = 0;
    const app = createApp(
      deps({
        reload: async () => {
          called++;
        },
      }),
    );
    const res = await app.request("/admin/reload", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(called).toBe(1);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
