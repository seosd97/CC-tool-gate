import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AuditSink, DecisionCache, LlmJudge } from "@/core/contracts";
import { createGate } from "@/core/gate";
import { type PolicySnapshot, PreToolUseRequest } from "@/core/policy";
import { getErrorMessage } from "@/lib/errors";
import { log } from "@/lib/logger";

export interface AppDeps {
  authToken: string;
  llm: LlmJudge;
  cache: DecisionCache;
  sink: AuditSink;
  getSnapshot: () => PolicySnapshot;
  reload: () => Promise<void>;
  maxBodyBytes?: number;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const gate = createGate({
    llm: deps.llm,
    cache: deps.cache,
    sink: deps.sink,
    getSnapshot: deps.getSnapshot,
  });
  const maxBodyBytes = deps.maxBodyBytes ?? 64 * 1024;

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    log.error({ error: getErrorMessage(err), path: c.req.path }, "Unhandled request error");
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  const protectedRoutes = new Hono();
  protectedRoutes.use("*", bearerAuth({ token: deps.authToken }));

  protectedRoutes.post("/v1/pretooluse", bodyLimit({ maxSize: maxBodyBytes }), async (c) => {
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
