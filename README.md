# BugStalker for VS Code

VS Code debug adapter integration for
[BugStalker](https://github.com/gilescope/BugStalker) — a pure-Rust,
DWARF-native debugger purpose-built for Rust:

- v0 + legacy symbol demangling via an in-tree parser.
- vtable-driven concrete-type recovery for `Box<dyn Trait>`,
  `Pin<Box<dyn Future>>`, and friends.
- Niche-resilient `Option<T>` / `Result<T, E>` decoding (zero-bit /
  null-pointer / NonZero* / `bool` / `char` / fn-pointer niches).
- `Rc<T>` / `Arc<T>` cycle detection with depth-bounded rendering.
- Tokio async await-trace: per-task awaitee chain with recovered
  source coordinates from `DW_AT_decl_file` / `DW_AT_decl_line`.

The extension itself is a thin shim: it spawns the BugStalker
binary in stdio DAP mode (`bugstalker --dap`) and otherwise stays
out of the way. No LLDB libraries, no Python, no platform-specific
adapter binaries to download.

## Quick start

1. Install the BugStalker binary somewhere on your `PATH`:

   ```sh
   cargo install bugstalker
   ```

   Or build from source:

   ```sh
   git clone https://github.com/gilescope/BugStalker
   cd BugStalker && cargo install --path .
   ```

2. Make sure the binary has the OS permissions it needs for ptrace:

   - **macOS**: codesign with the `task_for_pid` entitlement
     (BugStalker's repo carries the entitlements file).
   - **Linux**: install with `setcap cap_sys_ptrace=ep`, run under
     `sudo`, or set `kernel.yama.ptrace_scope = 0`.

3. Add a `launch.json` configuration:

   ```jsonc
   {
       "version": "0.2.0",
       "configurations": [
           {
               "name": "Debug",
               "type": "bugstalker",
               "request": "launch",
               "cargo": { "args": ["build", "--bin=my_bin"] },
               "args": [],
               "cwd": "${workspaceFolder}"
           }
       ]
   }
   ```

   F5 to start. Cargo runs first, the produced artefact becomes
   `program`, and BugStalker takes over.

See [`BUGSTALKER.md`](BUGSTALKER.md) for the full quickstart,
settings, cargo block reference, and what's wired through the DAP
channel (including the BugStalker-specific `bs/awaitTrace` custom
request).

## Building the extension

```sh
npm install
npm run build              # webpack production bundle into out/extension.js
# or:
npm run watch              # development build, rebuild on change
npm run typecheck          # tsc --noEmit only
```

`earthly +bs-gate` (or `+all`) runs the same gate the Earthfile-
based CI uses.

## Cutting a signed release

```sh
earthly +release           # +all + GPG-detached signature on the .vsix
```

`+release` runs `+all` (lint + typecheck + webpack + vsix) and
then `+sign-vsix`, which is a `LOCALLY` target — it runs on the
host so it can reach your GPG agent / yubikey pinentry. Output:

- `build/vscode-bugstalker.vsix`
- `build/vscode-bugstalker.vsix.asc` (GPG detached, ASCII-armoured)

Signing key selection, in priority order:

1. `earthly --GPG_KEY=<long-id> +sign-vsix` — explicit override
2. `git config user.signingkey` — the same key you sign commits
   with; the typical case
3. GPG's default identity, otherwise

`+sign-vsix` round-trips the signature through `gpg --verify`
before exiting, so a bad signing pipeline fails loudly instead of
silently producing a corrupt `.asc`. With a yubikey backing the
key, the target will prompt for a touch.

Day-to-day work stays touch-free — `+all` deliberately omits
signing. Only invoke `+release` (or `+sign-vsix` directly) when
you actually want a signed artefact.

## License

MIT. Forked from [`vadimcn/vscode-lldb`](https://github.com/vadimcn/vscode-lldb)
(also MIT) as a starting point; the LLDB-side code (codelldb adapter,
LLDB shared-library lookups, Python integration) has been removed
since BugStalker is its own pure-Rust DAP server.
