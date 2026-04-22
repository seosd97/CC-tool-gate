import Anthropic from "@anthropic-ai/sdk";
import {
  LlmDecision,
  type LlmJudge,
  type Policy,
  type PreToolUseRequest,
} from "../core/types";

export interface LlmJudgeOptions {
  apiKey: string;
  model: string;
  /** Optional Anthropic client override (used by tests). */
  client?: Anthropic;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You are a safety gate for a developer agent. The agent is about to call a tool, and you must approve it.

You will receive natural-language policies (markdown). Each policy says what to allow, deny, or ask about for matching tool calls.

Decide one of:
  - "allow": the tool call is safe under the policies
  - "deny": the tool call violates a policy and must not run
  - "ask": you cannot decide without human input; the user will be prompted

Reply with ONLY a JSON object on a single line, no prose, no code fence:
{"decision":"allow|deny|ask","reason":"<one sentence>"}`;

export function createLlmJudge(opts: LlmJudgeOptions): LlmJudge {
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs });

  return {
    async judge({ request, policies }) {
      const policiesText = policies
        .map(
          (p) =>
            `### Policy: ${p.name}\n` +
            `default_decision: ${p.default_decision}\n` +
            `description: ${p.description}\n\n${p.body}`,
        )
        .join("\n\n---\n\n");

      const userText =
        `Tool: ${request.tool_name}\n` +
        `Tool input (JSON):\n${JSON.stringify(request.tool_input, null, 2)}\n\n` +
        `cwd: ${request.cwd}`;

      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 256,
        system: `${SYSTEM_PROMPT}\n\nPolicies in scope:\n\n${policiesText}`,
        messages: [{ role: "user", content: userText }],
      });

      const text = extractText(response);
      return parseJsonDecision(text);
    },
  };
}

function extractText(resp: Anthropic.Messages.Message): string {
  for (const block of resp.content) {
    if (block.type === "text") return block.text;
  }
  throw new Error("LLM returned no text content");
}

export function parseJsonDecision(text: string): LlmDecision {
  // Tolerate code fences or surrounding prose by extracting the first {...} block.
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`LLM output is not JSON: ${trimmed.slice(0, 200)}`);
  }
  const slice = trimmed.slice(start, end + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(slice);
  } catch (e) {
    throw new Error(`LLM JSON parse failed: ${(e as Error).message}`);
  }
  const parsed = LlmDecision.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`LLM JSON shape invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}
