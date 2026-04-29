# BugStalker integration

This extension registers a single debug adapter type, `bugstalker`,
backed by [BugStalker](https://github.com/gilescope/BugStalker) — a
Rust-aware, DWARF-native, pure-Rust debugger. No LLDB libraries, no
Python, no platform-specific adapter binaries to download.

## What you get

`bugstalker` is Rust-first. It demangles v0 and legacy mangling with
an in-tree parser, recovers concrete types behind `dyn Trait` from
vtable symbols, prints niche-encoded `Option`/`Result` correctly,
detects `Rc`/`Arc` cycles, and walks `tokio` async backtraces with
recovered `.await` source coords. For C++ / Swift / non-Rust
targets, use a different debugger (e.g. CodeLLDB upstream).

## One-time install

1. Install the BugStalker binary. The Cargo package is named
   `bugstalker` but the produced binary is **`bs`**:

   ```sh
   cargo install bugstalker            # installs ~/.cargo/bin/bs
   # or, from a local checkout:
   cargo install --path /path/to/BugStalker
   ```

   By default the extension launches `bs` from your `PATH`.
   Point the extension at a different binary via the
   `bugstalker.executable` setting if needed (e.g. an absolute
   path to a development build, or `bugstalker` if you symlinked
   under that name).

2. Give the binary the OS permissions it needs for ptrace.
   **Skipping this step is the most common reason BugStalker
   "runs the program but doesn't pause on breakpoints":** the
   debuggee is spawned correctly, but the actual
   ptrace/`task_for_pid` attach fails silently and BugStalker
   loses control of the process.

   - **macOS**: easiest path is the BugStalker repo's
     `+install-darwin` Earthly target, which combines step 1 and
     step 2 in one go:

     ```sh
     cd /path/to/BugStalker
     earthly +install-darwin
     ```

     Or do the codesign yourself against an existing `bs`:

     ```sh
     codesign -s - --force \
         --entitlements /path/to/BugStalker/tests/darwin.entitlements \
         "$(which bs)"
     ```

     Verify with `codesign -d --entitlements - "$(which bs)"` —
     the output should contain `com.apple.security.cs.debugger`.
     If the entitlement is missing you'll see
     `Mach kr=0x00000005: KERN_FAILURE` in the adapter log and
     `configurationDone` will fail with the actionable
     `DarwinDebuggerEntitlementMissing` error in the VS Code
     popup.
   - **Linux**: install with `setcap cap_sys_ptrace=ep` *or* run
     under `sudo`, *or* set `kernel.yama.ptrace_scope = 0`.

## Minimum `launch.json`

```jsonc
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch (BugStalker)",
            "type": "bugstalker",
            "request": "launch",
            "program": "${workspaceFolder}/target/debug/my_bin",
            "args": [],
            "cwd": "${workspaceFolder}"
        }
    ]
}
```

Attaching to a running process:

```jsonc
{
    "name": "Attach (BugStalker)",
    "type": "bugstalker",
    "request": "attach",
    "pid": 12345
}
```

## Settings

| Setting | Default | Purpose |
| ------- | ------- | ------- |
| `bugstalker.executable` | `bs`    | Path / name of the BugStalker binary used as the DAP adapter. The default matches `cargo install bugstalker` (package is `bugstalker`, bin is `bs`). |
| `bugstalker.logFile`    | unset   | When set, BugStalker writes adapter diagnostics to this file (`--dap-log-file`). Useful when filing issues. |
| `bugstalker.adapterEnv` | `{}`    | Extra env vars for the spawned BugStalker process and for `cargo` invocations driven by the `cargo` block. |

## What's wired up

- Standard DAP: breakpoints, function breakpoints, stack frames,
  scopes, variables, threads, step in/out/over, continue, evaluate.
- BugStalker-specific custom request `bs/awaitTrace` — call it from
  a debug-console snippet or extension to render the current task's
  awaitee chain (Phase 3 D3a). Schema documented at
  `doc/plans/phase-3-dyn-trait-and-async.md` in the BugStalker repo.

## Cargo build integration

Set a `cargo` block in `launch.json` and BugStalker will build the
target and use the produced artifact as `program`:

```jsonc
{
    "name": "Debug Cargo binary",
    "type": "bugstalker",
    "request": "launch",
    "cargo": {
        "args": ["build", "--bin=my_bin"]
    },
    "args": [],
    "cwd": "${workspaceFolder}"
}
```

```jsonc
{
    "name": "Debug Cargo unit tests",
    "type": "bugstalker",
    "request": "launch",
    "cargo": {
        "args": ["test", "--no-run", "--lib"],
        "filter": { "name": "my_lib", "kind": "lib" }
    },
    "args": [],
    "cwd": "${workspaceFolder}"
}
```

`${cargo:program}` is also expanded inside the rest of the config.
Multiple matching artefacts trigger an error; use the `cargo.filter`
field (`{ "name": "...", "kind": "..." }`) to narrow.

## Limitations

- No source-map remapping (yet). Paths come from DWARF as-is.
- `bugstalker` is in active development; treat the integration as
  preview-grade.

## Implementation notes

The extension is a thin shim — under 200 lines of TypeScript total:

- `extension/main.ts` registers the `bugstalker` debug adapter
  descriptor factory and the config provider.
- `extension/novsc/bugstalker.ts` builds a `DebugAdapterExecutable`
  that spawns `bs --dap` over stdio (no TCP handshake, no
  port-scanning regex) and a `BugStalkerConfigProvider` that
  expands the `cargo` block before the adapter is spawned.
- `extension/cargo.ts` (carried over from the upstream
  `vscode-lldb` fork as the language-agnostic helper) runs `cargo
  build --message-format=json`, picks the matching
  `compiler-artifact`, and supplies the path for `${cargo:program}`
  expansion.

That's the whole extension — the rest is package metadata, a
webpack config that bundles the entry point into `out/extension.js`,
and the `tsconfig.json`.
