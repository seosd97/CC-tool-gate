import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPolicyRegistry,
  createSourceProvider,
} from "../../src/adapters/sources";
import type { SourceProvider } from "../../src/core/types";

const POLICY_MD = `---
name: env-files
description: protect secrets
triggers:
  tool_names: ["Bash"]
  patterns: ["\\\\.env"]
default_decision: deny
---

body
`;

const INDEX_YAML = `
hard_deny:
  tool_names: ["BashWebSearch"]
  patterns: ["rm -rf"]
hard_allow:
  patterns: ["^echo "]
`;

describe("file source", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-src-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads .md policies and index.yaml", async () => {
    await writeFile(join(dir, "env.md"), POLICY_MD);
    await writeFile(join(dir, "index.yaml"), INDEX_YAML);
    const src = createSourceProvider(`file://${dir}`);
    const { policies, index } = await src.load();
    expect(policies.map((p) => p.name)).toEqual(["env-files"]);
    expect(index?.hard_deny.patterns).toEqual(["rm -rf"]);
    expect(index?.hard_allow.patterns).toEqual(["^echo "]);
  });

  test("ignores non-md files and bad frontmatter", async () => {
    await writeFile(join(dir, "ok.md"), POLICY_MD);
    await writeFile(join(dir, "bad.md"), "no frontmatter here");
    await writeFile(join(dir, "ignored.txt"), "x");
    const src = createSourceProvider(`file://${dir}`);
    const { policies } = await src.load();
    expect(policies.map((p) => p.name)).toEqual(["env-files"]);
  });
});

describe("inline source", () => {
  test("decodes base64 markdown", async () => {
    const b64 = Buffer.from(POLICY_MD).toString("base64");
    const src = createSourceProvider(`inline:${b64}`);
    const { policies } = await src.load();
    expect(policies[0]!.name).toBe("env-files");
  });
});

describe("createSourceProvider", () => {
  test("rejects unknown schemes", () => {
    expect(() => createSourceProvider("ftp://example.com/")).toThrow();
  });
});

describe("http source timeout", () => {
  test("aborts fetch that exceeds timeoutMs", async () => {
    // Server that never responds — forces the AbortController path.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const src = createSourceProvider(
        `http://127.0.0.1:${server.port}/policy.md`,
        { timeoutMs: 50 },
      );
      const t0 = Date.now();
      let err: unknown;
      try {
        await src.load();
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      // Should abort well under a generous ceiling rather than hang forever.
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });
});

describe("policy registry", () => {
  test("merges layers (later overrides earlier by name)", async () => {
    const a: SourceProvider = {
      uri: "a",
      load: async () => ({
        policies: [
          {
            name: "x",
            description: "v1",
            triggers: { tool_names: [], patterns: [] },
            default_decision: "ask",
            body: "",
            source: "a",
          },
        ],
      }),
    };
    const b: SourceProvider = {
      uri: "b",
      load: async () => ({
        policies: [
          {
            name: "x",
            description: "v2",
            triggers: { tool_names: [], patterns: [] },
            default_decision: "deny",
            body: "",
            source: "b",
          },
        ],
        index: {
          hard_deny: { tool_names: ["X"], patterns: [] },
          hard_allow: { tool_names: [], patterns: [] },
        },
      }),
    };

    const reg = createPolicyRegistry({ sources: [a, b] });
    await reg.reload();
    const snap = reg.snapshot();
    expect(snap.policies).toHaveLength(1);
    expect(snap.policies[0]!.description).toBe("v2");
    expect(snap.index.hard_deny.tool_names).toEqual(["X"]);
  });

  test("survives one source throwing", async () => {
    const ok: SourceProvider = {
      uri: "ok",
      load: async () => ({
        policies: [
          {
            name: "y",
            description: "",
            triggers: { tool_names: [], patterns: [] },
            default_decision: "ask",
            body: "",
            source: "ok",
          },
        ],
      }),
    };
    const broken: SourceProvider = {
      uri: "broken",
      load: async () => {
        throw new Error("boom");
      },
    };
    const reg = createPolicyRegistry({ sources: [broken, ok] });
    await reg.reload();
    expect(reg.snapshot().policies.map((p) => p.name)).toEqual(["y"]);
  });
});
