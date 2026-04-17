import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
import { createPipeline } from "../core/pipeline";
import type { RedactRule } from "../core/redact";
import {
  PreToolUseRequest,
  type DecisionCache,
  type LlmJudge,
  type AuditSink,
  type IndexConfig,
  type Policy,
} from "../core/types";

export interface AppDeps {
  authToken: string;
  llm: LlmJudge;
  cache: DecisionCache;
  sink: AuditSink;
  getSnapshot: () => { policies: Policy[]; index: IndexConfig };
  reload: () => Promise<void>;
  redactRules?: readonly RedactRule[];
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const pipeline = createPipeline({
    llm: deps.llm,
    cache: deps.cache,
    sink: deps.sink,
    getSnapshot: deps.getSnapshot,
    redactRules: deps.redactRules,
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      policies: deps.getSnapshot().policies.length,
      cache_size: deps.cache.size(),
    }),
  );

  const protectedRoutes = new Hono();
  protectedRoutes.use("*", bearerAuth({ token: deps.authToken }));

  protectedRoutes.post("/v1/pretooluse", async (c) => {
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
    const result = await pipeline.decide(parsed.data);
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
    // Policies may have changed — drop cached decisions so the next request
    // is evaluated under the new rules instead of returning a stale verdict.
    deps.cache.clear();
    const snap = deps.getSnapshot();
    return c.json({ ok: true, policies: snap.policies.length });
  });

  app.route("/", protectedRoutes);
  return app;
}

// Re-export the schema in case other modules want it for testing.
export { PreToolUseRequest };
export type { z };
