import { describe, expect, test } from "bun:test";
import {
  anyPatternMatches,
  matchPolicies,
  mergePolicies,
  parsePolicy,
  toolInputHaystack,
} from "../../src/core/policy";
import type { Policy, PreToolUseRequest } from "../../src/core/types";

const sample = `---
name: env-files
description: protect secrets
triggers:
  tool_names: ["Bash", "Read"]
  patterns: ["\\\\.env", "credentials"]
default_decision: deny
---

# body
do not touch .env
`;

describe("parsePolicy", () => {
  test("parses valid frontmatter", () => {
    const p = parsePolicy("inline:test", sample);
    expect(p).not.toBeNull();
    expect(p!.name).toBe("env-files");
    expect(p!.triggers.tool_names).toEqual(["Bash", "Read"]);
    expect(p!.default_decision).toBe("deny");
    expect(p!.body).toContain("do not touch .env");
  });

  test("returns null on missing name", () => {
    const bad = `---\ndescription: oops\n---\nbody`;
    expect(parsePolicy("x", bad)).toBeNull();
  });

  test("returns null on no frontmatter", () => {
    expect(parsePolicy("x", "just body")).toBeNull();
  });
});

describe("toolInputHaystack", () => {
  test("flattens nested objects to a string", () => {
    const h = toolInputHaystack({
      command: "rm -rf node_modules",
      nested: { path: "/etc/.env", arr: ["secrets/foo", 42] },
    });
    expect(h).toContain("rm -rf node_modules");
    expect(h).toContain("/etc/.env");
    expect(h).toContain("secrets/foo");
    expect(h).toContain("42");
  });
});

describe("anyPatternMatches", () => {
  test("matches case-insensitive regex", () => {
    expect(anyPatternMatches(["\\.env"], "/path/.ENV")).toBe(true);
  });
  test("falls back to substring on invalid regex", () => {
    expect(anyPatternMatches(["[unclosed"], "x [unclosed y")).toBe(true);
  });
  test("returns false when nothing matches", () => {
    expect(anyPatternMatches(["foo", "bar"], "baz")).toBe(false);
  });
  test("repeated calls with the same array reuse compiled regexes", () => {
    // Hitting the precompile cache: mixed valid + invalid patterns called
    // many times against varying haystacks must stay correct.
    const patterns = ["\\.env", "[unclosed", "^echo "];
    for (let i = 0; i < 100; i++) {
      expect(anyPatternMatches(patterns, "cat /etc/.env")).toBe(true);
      expect(anyPatternMatches(patterns, "x [unclosed y")).toBe(true);
      expect(anyPatternMatches(patterns, "echo hi")).toBe(true);
      expect(anyPatternMatches(patterns, "nope")).toBe(false);
    }
  });
});

describe("matchPolicies", () => {
  const policies: Policy[] = [
    {
      name: "env-files",
      description: "",
      triggers: { tool_names: ["Bash", "Read"], patterns: ["\\.env"] },
      default_decision: "deny",
      body: "",
      source: "x",
    },
    {
      name: "no-triggers",
      description: "",
      triggers: { tool_names: [], patterns: [] },
      default_decision: "ask",
      body: "",
      source: "x",
    },
    {
      name: "any-bash",
      description: "",
      triggers: { tool_names: ["Bash"], patterns: [] },
      default_decision: "ask",
      body: "",
      source: "x",
    },
  ];

  const req = (overrides: Partial<PreToolUseRequest>): PreToolUseRequest => ({
    session_id: "s",
    cwd: "/c",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat /etc/.env" },
    ...overrides,
  });

  test("matches based on tool + pattern", () => {
    const out = matchPolicies(req({}), policies);
    expect(out.map((p) => p.name).sort()).toEqual(["any-bash", "env-files"]);
  });

  test("excludes policies with no triggers at all", () => {
    const out = matchPolicies(req({}), policies);
    expect(out.find((p) => p.name === "no-triggers")).toBeUndefined();
  });

  test("tool_names filter excludes wrong tool", () => {
    const out = matchPolicies(req({ tool_name: "Write", tool_input: { file_path: ".env" } }), policies);
    expect(out.map((p) => p.name)).toEqual([]);
  });
});

describe("mergePolicies", () => {
  test("later layers override earlier by name", () => {
    const a: Policy = {
      name: "x",
      description: "v1",
      triggers: { tool_names: [], patterns: [] },
      default_decision: "ask",
      body: "",
      source: "a",
    };
    const b: Policy = { ...a, description: "v2", source: "b" };
    const out = mergePolicies([[a], [b]]);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toBe("v2");
    expect(out[0]!.source).toBe("b");
  });
});
