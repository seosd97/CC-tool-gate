---
name: package-install
description: Watch for package installs from untrusted registries or with arbitrary post-install scripts.
default_decision: ask
---

# Package install policy

Installing packages can execute arbitrary post-install scripts. Watch for
suspicious registry overrides or unsigned packages.

## deny

- Installs that override the registry to an unknown host
  (`--registry=http://...` with a non-standard URL).
- `curl | sh` style one-liner installers that download and execute
  untrusted code without verification.

## allow

- `npm install`, `bun install`, `pnpm install`, `yarn install` with no
  registry override in a project that already has a lockfile.
- Adding packages that are well-known and widely used
  (e.g. `lodash`, `express`, `zod`).

## ask

- Adding new packages from the default registry when no lockfile exists.
- Installing packages with a `--registry` flag pointing to a known
  internal registry (may be fine, but worth confirming).
