import { describe, expect, test } from "bun:test";
import { createLlmJudge, parseJsonDecision } from "@/adapters/llm";
import type { Policy, PreToolUseRequest } from "@/core/policy";

describe("parseJsonDecision", () => {
  test("parses bare JSON", () => {
    const out = parseJsonDecision('{"decision":"allow","reason":"safe"}');
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("safe");
  });

  test("extracts JSON from prose", () => {
    const out = parseJsonDecision('here you go: {"decision":"deny","reason":"bad"} ok');
    expect(out.decision).toBe("deny");
  });

  test("strips code fences", () => {
    const out = parseJsonDecision('```json\n{"decision":"ask","reason":"need clarity"}\n```');
    expect(out.decision).toBe("ask");
  });

  test("throws on no JSON", () => {
    expect(() => parseJsonDecision("nope")).toThrow();
  });

  test("throws on bad shape", () => {
    expect(() => parseJsonDecision('{"decision":"yes","reason":"x"}')).toThrow();
  });
});

describe("createLlmJudge", () => {
  test("calls SDK and parses response", async () => {
    let captured: any = null;
    const fakeClient: any = {
      messages: {
        create: async (params: any) => {
          captured = params;
          return {
            content: [{ type: "text", text: '{"decision":"deny","reason":"bad command"}' }],
          };
        },
      },
    };
    const judge = createLlmJudge({
      apiKey: "test",
      model: "claude-haiku-4-5",
      client: fakeClient,
    });

    const req: PreToolUseRequest = {
      session_id: "s",
      cwd: "/c",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    };
    const policies: Policy[] = [
      {
        name: "destructive",
        description: "no rm -rf",
        default_decision: "deny",
        body: "deny rm -rf",
        source: "x",
      },
    ];

    const out = await judge.judge({ request: req, policies });
    expect(out.decision).toBe("deny");
    expect(captured.model).toBe("claude-haiku-4-5");
    expect(typeof captured.system).toBe("string");
    expect(captured.system).toContain("destructive");
    expect(captured.messages[0].content).toContain("rm -rf /");
  });
});
