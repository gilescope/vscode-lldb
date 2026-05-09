// Bridge to BugStalker's stdio DAP server. Selected by
// `"type": "bugstalker"` in launch.json.
//
// BugStalker speaks DAP directly over stdin/stdout when invoked
// with `--dap`, so VS Code's `DebugAdapterExecutable` is enough —
// no TCP handshake, no `Listening on port N` regex.
//
// Default executable is `bs` — the binary name `cargo install
// bugstalker` produces (the package is `bugstalker` but the
// `[[bin]]` is `bs`). Override via the `bugstalker.executable`
// setting if your binary lives somewhere else.
import {
    CancellationToken,
    DebugAdapterExecutable,
    DebugConfiguration,
    DebugConfigurationProvider,
    ExtensionContext,
    WorkspaceConfiguration,
    WorkspaceFolder,
    window,
    workspace,
} from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import stringArgv from 'string-argv';
import { Cargo, expandCargo } from '../cargo';
import { output } from '../main';
import { ensureBsEntitled } from './darwinSign';

// Resolve a log path even when the user hasn't set `bugstalker.logFile`.
// Without a log file the BugStalker binary's diagnostics go nowhere
// (DAP traffic is on stdin/stdout, stderr is consumed by VS Code's
// adapter plumbing) and "ran but didn't break" failures become opaque.
// Default to a deterministic per-extension path so there's always
// something to tail.
function defaultLogFile(context: ExtensionContext | undefined): string | undefined {
    if (!context) return undefined;
    const dir = context.logUri?.fsPath ?? context.globalStorageUri?.fsPath;
    if (!dir) return undefined;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    return path.join(dir, 'bugstalker-dap.log');
}

export async function getBugStalkerAdapterExecutable(
    config: WorkspaceConfiguration,
    context?: ExtensionContext,
): Promise<DebugAdapterExecutable> {
    const exe = config.get<string>('executable', 'bs');
    const logFile = config.get<string>('logFile') || defaultLogFile(context);

    const args: string[] = ['--dap'];
    if (logFile) {
        args.push('--dap-log-file', logFile);
    }

    output.appendLine(
        `[${new Date().toISOString()}] adapter spawn exe=${exe} args=${JSON.stringify(args)}`,
    );

    // Best-effort: ensure the macOS cs.debugger entitlement is in
    // place before spawning. Never throws — if signing fails, bs
    // starts anyway and surfaces its own descriptive error.
    await ensureBsEntitled(exe, output);

    return new DebugAdapterExecutable(exe, args);
}

/// Minimal config provider that handles the things a Rust user
/// reasonably expects — cargo build integration, string-form `args`
/// — without dragging in any LLDB-specific machinery (libpython
/// lookup, lldb.launch defaults, dbgconfig expansion). Each is a
/// trivial reuse of the existing language-agnostic helpers.
export class BugStalkerConfigProvider implements DebugConfigurationProvider {
    async resolveDebugConfiguration(
        folder: WorkspaceFolder | undefined,
        launchConfig: DebugConfiguration,
        _token?: CancellationToken,
    ): Promise<DebugConfiguration | undefined | null> {
        if (launchConfig.type === undefined) {
            await window.showErrorMessage(
                'Cannot start debugging because no launch configuration has been provided.',
                { modal: true },
            );
            return null;
        }

        // `args` may arrive as a single string ("a b c") or already
        // as an array. Normalise to array.
        if (typeof launchConfig.args === 'string') {
            launchConfig.args = stringArgv(launchConfig.args);
        }

        // Cargo build integration. When `cargo` block is present:
        //
        //   1. run `cargo <args> --message-format=json`,
        //   2. read the produced compiler-artifact path,
        //   3. delete the `cargo` key so it doesn't reach the DAP
        //      adapter,
        //   4. substitute `${cargo:program}` placeholders in the
        //      remaining config,
        //   5. fill `program` with the artifact if the user didn't
        //      set one explicitly.
        //
        // Same shape as the LLDB path's cargo handling; the helpers
        // are language-agnostic so we reuse them verbatim.
        if (launchConfig.cargo !== undefined) {
            const cargoTomlFolder = folder ? folder.uri.fsPath : workspace.rootPath;
            if (!cargoTomlFolder) {
                await window.showErrorMessage(
                    'BugStalker cargo integration needs a workspace folder.',
                    { modal: true },
                );
                return null;
            }
            const adapterEnv = workspace
                .getConfiguration('bugstalker', folder?.uri)
                .get<{ [k: string]: string }>('adapterEnv', {});
            const cargo = new Cargo(cargoTomlFolder, adapterEnv);
            const program = await cargo.getProgramFromCargoConfig(launchConfig.cargo);
            const cargoDict = { program };
            delete launchConfig.cargo;

            launchConfig = expandCargo(launchConfig, cargoDict);

            if (launchConfig.program === undefined) {
                launchConfig.program = cargoDict.program;
            }
        }

        return launchConfig;
    }
}
