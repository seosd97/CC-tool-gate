import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyStore, loadPoliciesFromDir } from "@/adapters/sources";

const POLICY_MD = `---
name: env-files
description: protect secrets
default_decision: deny
---

body
`;

const INDEX_YAML = `
deny:
  tool_names: ["BashWebSearch"]
  patterns: ["rm -rf"]
allow:
  patterns: ["^echo "]
`;

describe("loadPoliciesFromDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccgate-src-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("loads .md policies and static rules", async () => {
    await writeFile(join(dir, "env.md"), POLICY_MD);
    await writeFile(join(dir, "index.yaml"), INDEX_YAML);
    const { policies, rules } = await loadPoliciesFromDir(dir);
    expect(policies.map((p) => p.name)).toEqual(["env-files"]);
    expect(rules?.deny.patterns.map((rx) => rx.source)).toEqual(["rm -rf"]);
    expect(rules?.allow.patterns.map((rx) => rx.source)).toEqual(["^echo "]);
  });

  test("ignores non-md files and bad frontmatter", async () => {
    await writeFile(join(dir, "ok.md"), POLICY_MD);
    await writeFile(join(dir, "bad.md"), "no frontmatter here");
    await writeFile(join(dir, "ignored.txt"), "x");
    const { policies } = await loadPoliciesFromDir(dir);
    expect(policies.map((p) => p.name)).toEqual(["env-files"]);
  });

  test("returns empty on unreadable directory", async () => {
    const { policies, rules } = await loadPoliciesFromDir("/nonexistent/path");
    expect(policies).toEqual([]);
    expect(rules).toBeUndefined();
  });
});

describe("createPolicyStore", () => {
  test("loads policies from multiple dirs", async () => {
    const dir1 = await mkdtemp(join(tmpdir(), "ccgate-store1-"));
    const dir2 = await mkdtemp(join(tmpdir(), "ccgate-store2-"));
    try {
      await writeFile(
        join(dir1, "a.md"),
        `---
name: policy-a
default_decision: allow
---

a
`,
      );
      await writeFile(
        join(dir2, "b.md"),
        `---
name: policy-b
default_decision: deny
---

b
`,
      );
      const store = createPolicyStore([dir1, dir2]);
      await store.reload();
      const snap = store.snapshot();
      expect(snap.policies.map((p) => p.name).sort()).toEqual(["policy-a", "policy-b"]);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  test("survives unreadable dir", async () => {
    const store = createPolicyStore(["/nonexistent/path"]);
    await store.reload();
    expect(store.snapshot().policies).toEqual([]);
  });

  test("concurrent reload calls share a single in-flight promise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccgate-coalesce-"));
    try {
      await writeFile(join(dir, "a.md"), POLICY_MD);
      const store = createPolicyStore([dir]);
      const p1 = store.reload();
      const p2 = store.reload();
      const p3 = store.reload();
      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
      await p1;
      expect(store.snapshot().policies.map((p) => p.name)).toEqual(["env-files"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fresh reload runs after the previous one completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccgate-fresh-"));
    try {
      await writeFile(join(dir, "a.md"), POLICY_MD);
      const store = createPolicyStore([dir]);
      await store.reload();
      expect(store.snapshot().policies).toHaveLength(1);

      await writeFile(
        join(dir, "b.md"),
        `---
name: second
default_decision: ask
---

second
`,
      );
      await store.reload();
      expect(
        store
          .snapshot()
          .policies.map((p) => p.name)
          .sort(),
      ).toEqual(["env-files", "second"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("later sources override earlier sources by name", async () => {
    const dir1 = await mkdtemp(join(tmpdir(), "ccgate-override1-"));
    const dir2 = await mkdtemp(join(tmpdir(), "ccgate-override2-"));
    try {
      await writeFile(
        join(dir1, "p.md"),
        `---
name: shared
default_decision: allow
---

original
`,
      );
      await writeFile(
        join(dir2, "p.md"),
        `---
name: shared
default_decision: deny
---

override
`,
      );
      const store = createPolicyStore([dir1, dir2]);
      await store.reload();
      const snap = store.snapshot();
      expect(snap.policies).toHaveLength(1);
      expect(snap.policies[0]?.default_decision).toBe("deny");
      expect(snap.policies[0]?.body).toBe("override");
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
