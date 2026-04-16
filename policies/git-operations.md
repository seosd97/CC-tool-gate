---
name: git-operations
description: Guardrails for risky git operations beyond plain destructive commands.
triggers:
  tool_names: ["Bash"]
  patterns:
    - "\\bgit\\s+config\\b"
    - "\\bgit\\s+commit\\s+--amend"
    - "\\bgit\\s+rebase\\b"
    - "\\bgit\\s+filter-(branch|repo)\\b"
    - "\\bgit\\s+push\\b"
    - "\\bgit\\s+remote\\s+(add|set-url)"
    - "--no-verify"
    - "--no-gpg-sign"
default_decision: ask
---

# Git operation policy

The agent should not silently change git identity, signing, or rewrite
history that the user has already pushed.

## deny

- `git config` writes that touch `user.email`, `user.name`,
  `commit.gpgsign`, `core.hooksPath`, or any global / system scope.
- `git commit --amend` of a commit that has already been pushed (when
  the agent can tell from context).
- `git filter-branch` / `git filter-repo` against the working repo.
- `git push --force` (covered by destructive-bash but reiterated here).
- Adding a brand-new git remote pointing at a non-obvious host.
- Any command using `--no-verify` or `--no-gpg-sign` flags - bypassing
  hooks or signing must be opt-in by the user.

## allow

- `git push` to the existing tracking remote on a feature branch.
- `git rebase main` / `git rebase -i HEAD~N` when the user explicitly
  asked for it and N is small.
- Local-scope `git config` reads (`git config --get`).

## ask

- Pushes to branches whose protection status is unknown.
- `git remote set-url` for an existing remote with a benign-looking URL.
