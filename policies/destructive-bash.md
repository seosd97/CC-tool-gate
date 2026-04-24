---
name: destructive-bash
description: Stop bash commands that delete data, format disks, or rewrite git history.
default_decision: ask
---

# Destructive bash policy

These commands can lose user work. The static rules already deny
`rm -rf /` and similar; this policy covers the broader class.

## deny

- `rm -rf` against absolute paths outside the current working tree
  (`cwd` is in the request).
- `git push --force` to `main` / `master` / `release/*` branches.
- `sudo` invocations of any kind. The agent has no business escalating.
- `git reset --hard` that would discard staged work the user has not
  reviewed (no clear context for "the user asked me to reset").

## allow

- `rm` of a single file or `rm -rf` of a directory that is clearly inside
  the project (path begins with `./`, `node_modules`, `dist`, `build`,
  `.next`, `target`, or a path the request itself just created).
- `git clean -fd` inside the cwd when the user explicitly asked for a
  clean build.
- `git push --force-with-lease` to a non-protected feature branch.

## ask

- Any other case where intent is unclear. Surface it to the user.
