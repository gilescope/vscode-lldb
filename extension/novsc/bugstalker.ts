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
    WorkspaceConfiguration,
    WorkspaceFolder,
    window,
    workspace,
} from 'vscode';
import stringArgv from 'string-argv';
import { Cargo, expandCargo } from '../cargo';

export function getBugStalkerAdapterExecutable(
    config: WorkspaceConfiguration,
): DebugAdapterExecutable {
    const exe = config.get<string>('executable', 'bs');
    const logFile = config.get<string>('logFile');

    const args: string[] = ['--dap'];
    if (logFile) {
        args.push('--dap-log-file', logFile);
    }

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
