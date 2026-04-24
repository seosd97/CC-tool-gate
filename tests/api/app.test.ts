import { describe, expect, test } from "bun:test";
import { createApp } from "@/api/app";
import type { AuditSink, DecisionCache, LlmJudge } from "@/core/gate";
import type { Policy, StaticRules } from "@/core/policy";

const TOKEN = "secret-token";

const emptyRules: StaticRules = {
  deny: { tool_names: [], patterns: [] },
  allow: { tool_names: [], patterns: [] },
};

function deps(
  over: {
    llm?: LlmJudge;
    policies?: Policy[];
    rules?: StaticRules;
    cache?: DecisionCache;
    sink?: AuditSink;
    reload?: () => Promise<void>;
  } = {},
) {
  const cache: DecisionCache = over.cache ?? {
    get() {
      return undefined;
    },
    set() {},
    clear() {},
    size() {
      return 0;
    },
  };
  const sink: AuditSink = over.sink ?? { write: async () => {} };
  return {
    authToken: TOKEN,
    llm: over.llm ?? {
      judge: async () => ({ decision: "allow" as const, reason: "ok" }),
    },
    cache,
    sink,
    getSnapshot: () => ({ policies: over.policies ?? [], rules: over.rules ?? emptyRules }),
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

  test("POST /admin/reload clears the decision cache", async () => {
    let cleared = 0;
    const cache: DecisionCache = {
      get: () => undefined,
      set: () => {},
      clear: () => {
        cleared++;
      },
      size: () => 0,
    };
    const app = createApp(deps({ cache }));
    const res = await app.request("/admin/reload", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(cleared).toBe(1);
  });
});
