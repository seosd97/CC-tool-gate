import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { type AuditSink, createGate, type DecisionCache, type LlmJudge } from "@/core/gate";
import { type Policy, PreToolUseRequest, type StaticRules } from "@/core/policy";

export interface AppDeps {
  authToken: string;
  llm: LlmJudge;
  cache: DecisionCache;
  sink: AuditSink;
  getSnapshot: () => { policies: Policy[]; rules: StaticRules };
  reload: () => Promise<void>;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const gate = createGate({
    llm: deps.llm,
    cache: deps.cache,
    sink: deps.sink,
    getSnapshot: deps.getSnapshot,
  });

  app.get("/health", (c) => c.json({ ok: true }));

  const protectedRoutes = new Hono();
  protectedRoutes.use("*", bearerAuth({ token: deps.authToken }));

  protectedRoutes.post("/v1/pretooluse", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = PreToolUseRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid PreToolUse request",
          issues: parsed.error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        },
        400,
      );
    }
    const result = await gate.decide(parsed.data);
    return c.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    });
  });

  protectedRoutes.post("/admin/reload", async (c) => {
    await deps.reload();
    deps.cache.clear();
    const snap = deps.getSnapshot();
    return c.json({ ok: true, policies: snap.policies.length });
  });

  app.route("/", protectedRoutes);
  return app;
}
