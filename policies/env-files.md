---
name: env-files
description: Protect .env files, credentials, and secret directories.
triggers:
  tool_names: ["Bash", "Edit", "Write", "Read", "MultiEdit"]
  patterns:
    - "(^|/)\\.env(\\.|$)"
    - "(^|/)\\.envrc"
    - "credentials(\\.|/)"
    - "(^|/)secrets/"
    - "id_rsa($|\\.)"
    - "id_ed25519($|\\.)"
    - "\\.pem$"
    - "\\.p12$"
default_decision: deny
---

# Secret-file protection

The agent must not read, write, edit, or print the contents of files that
likely contain credentials. The trigger patterns above catch the common
locations (`.env*`, `~/.aws/credentials`, `secrets/`, SSH private keys, PEM
bundles).

## deny

- Reading the file (`Read`, `cat`, `less`, `head`, `tail`, `bat`, etc.).
- Writing or editing the file from a shell or via Edit/Write/MultiEdit.
- Echoing or piping the file content to another process or to the model.
- Sending it across the network (curl `-T`, scp, base64-then-print, etc.).

## allow

- Tool calls that only check for existence or list the directory
  (`ls`, `test -f`, `stat` without `-c %s`-of-content). These do not leak
  the secret material itself.
- Creating a brand-new template file under a different name
  (e.g. `.env.example`) where the content is provided in the tool input
  and contains no real secrets.

## ask

- Anything ambiguous: copying the file to a sibling, renaming it, or
  including it in a glob whose intent is not obviously read.
