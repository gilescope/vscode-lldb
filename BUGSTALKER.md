# BugStalker integration

This fork registers a second debug adapter type, `bugstalker`,
alongside the upstream `lldb` type. Selecting `"type": "bugstalker"`
in your `launch.json` routes the session through
[BugStalker](https://github.com/gilescope/BugStalker) — a Rust-aware,
DWARF-native, pure-Rust debugger — rather than LLDB. The LLDB path
is untouched; both can coexist.

## When to pick `bugstalker` over `lldb`

`bugstalker` is Rust-first. It demangles v0 and legacy mangling with
an in-tree parser, recovers concrete types behind `dyn Trait` from
vtable symbols, prints niche-encoded `Option`/`Result` correctly,
detects `Rc`/`Arc` cycles, and walks `tokio` async backtraces with
recovered `.await` source coords. If those features matter for what
you are debugging, pick `bugstalker`. If you need LLDB's broader
language coverage (C++, Swift, …), stay on `lldb`.

## One-time install

1. Install the BugStalker binary:

   ```sh
   cargo install bugstalker            # or: cargo install --path . from the BugStalker repo
   ```

   By default the extension launches `bugstalker` from your `PATH`.
   Point the extension at a different binary via the
   `bugstalker.executable` setting if needed.

2. Make sure the binary has the entitlements / permissions your OS
   requires for ptrace:
   - **macOS**: `codesign -s - --entitlements ... bugstalker`
     (BugStalker's repo carries the `.entitlements` file).
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

| Setting                 | Default      | Purpose                                                                                                     |
| ----------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `bugstalker.executable` | `bugstalker` | Path / name of the BugStalker binary used as the DAP adapter.                                               |
| `bugstalker.logFile`    | unset        | When set, BugStalker writes adapter diagnostics to this file (`--dap-log-file`). Useful when filing issues. |

## What's wired up

- Standard DAP: breakpoints, function breakpoints, stack frames,
  scopes, variables, threads, step in/out/over, continue, evaluate.
- BugStalker-specific custom request `bs/awaitTrace` — call it from
  a debug-console snippet or extension to render the current task's
  awaitee chain (Phase 3 D3a). Schema documented at
  `doc/plans/phase-3-dyn-trait-and-async.md` in the BugStalker repo.

## Limitations

- No source-map remapping (yet). Paths come from DWARF as-is.
- Cargo build integration (the upstream fork's `cargo`/`${cargo:program}`
  handling) is **not** wired through to the BugStalker side. Build
  yourself, then point `program` at the artifact.
- `bugstalker` is in active development; treat the integration as
  preview-grade.

## Implementation notes

The integration is intentionally minimal — about 100 lines of patch
on top of the upstream extension:

- `extension/novsc/bugstalker.ts` builds a `DebugAdapterExecutable`
  that spawns `bugstalker --dap` over stdio. No TCP handshake, no
  port-scanning regex.
- `extension/main.ts` registers a second
  `DebugAdapterDescriptorFactory` for the `bugstalker` type.
- `package.json` adds the `bugstalker` debugger entry, two config
  settings (`bugstalker.executable` / `bugstalker.logFile`), and
  two configuration snippets.

The LLDB path (the `lldb` debug type, the codelldb binary, the
LLDB shared library lookups) is unchanged and unaware of any of
this.
