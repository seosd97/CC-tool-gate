---
name: package-install
description: Watch for package installs from untrusted registries or with arbitrary post-install scripts.
triggers:
  tool_names: ["Bash"]
  patterns:
    - "\\b(npm|pnpm|yarn|bun)\\s+(install|add|i)\\b"
    - "\\b(npm|pnpm|yarn|bun)\\s+(install|add|i)\\s+.*--registry"
    - "\\bpip(3)?\\s+install\\b"
    - "\\bpipx\\s+install\\b"
    - "\\buv\\s+(add|pip\\s+install)\\b"
    - "\\bcargo\\s+install\\b"
    - "\\bgo\\s+install\\b"
    - "\\bbrew\\s+install\\b"
    - "\\bcurl\\b.*\\|\\s*(sh|bash|zsh)"
    - "\\bwget\\b.*\\|\\s*(sh|bash|zsh)"
default_decision: ask
---

# Package install policy

Installing a package can run arbitrary code (post-install scripts,
build.rs, setup.py). The bar should be: is this a well-known package
from the default registry?

## deny

- `curl ... | sh` and equivalents. There is essentially never a good
  reason for the agent to pipe a remote script into a shell.
- Installing from a non-default registry (`--registry` flag pointing at
  something other than the official registry for that ecosystem).
- Installing a package whose name contains an obvious typo of a popular
  package (typosquat heuristic - if you cannot tell, ask).
- Global installs that would modify the user's PATH (`npm i -g`,
  `cargo install`, `go install`, `brew install`) when the user did not
  ask for a CLI tool.

## allow

- `bun add`, `pnpm add`, `npm install`, `yarn add`, `pip install`, etc.
  for a single named, well-known package being added to the current
  project (not global) and recorded in the manifest.
- Installing the project's own dependencies from an existing lockfile
  (`bun install`, `npm ci`, `pnpm install --frozen-lockfile`).

## ask

- Adding a less-known package, or any install where the agent cannot
  recognize the package name. The user should confirm.
