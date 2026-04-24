import { describe, expect, test } from "bun:test";
import { PermissionDecision, parsePolicy } from "@/core/policy";

const sample = `---
name: env-files
description: protect secrets
default_decision: deny
---

# body
do not touch .env
`;

describe("parsePolicy", () => {
  test("parses valid frontmatter", () => {
    const p = parsePolicy("inline:test", sample);
    expect(p).not.toBeNull();
    expect(p?.name).toBe("env-files");
    expect(p?.default_decision).toBe("deny");
    expect(p?.body).toContain("do not touch .env");
  });

  test("returns null on missing name", () => {
    const bad = `---\ndescription: oops\n---\nbody`;
    expect(parsePolicy("x", bad)).toBeNull();
  });

  test("returns null on no frontmatter", () => {
    expect(parsePolicy("x", "just body")).toBeNull();
  });

  test("default_decision defaults to ask", () => {
    const minimal = `---\nname: test\n---\nbody`;
    const p = parsePolicy("x", minimal);
    expect(p?.default_decision).toBe("ask");
  });
});

describe("PermissionDecision", () => {
  test("accepts valid values", () => {
    expect(PermissionDecision.parse("allow")).toBe("allow");
    expect(PermissionDecision.parse("deny")).toBe("deny");
    expect(PermissionDecision.parse("ask")).toBe("ask");
  });

  test("rejects invalid values", () => {
    expect(() => PermissionDecision.parse("maybe")).toThrow();
  });
});
