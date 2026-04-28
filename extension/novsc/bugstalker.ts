// Bridge to BugStalker's stdio DAP server. Co-exists with the
// codelldb path; selected by `"type": "bugstalker"` in launch.json.
//
// BugStalker speaks DAP directly over stdin/stdout when invoked
// with `--dap`, so VS Code's `DebugAdapterExecutable` is enough —
// no TCP handshake, no `Listening on port N` regex.
import { DebugAdapterExecutable, WorkspaceConfiguration } from 'vscode';

export function getBugStalkerAdapterExecutable(
    config: WorkspaceConfiguration,
): DebugAdapterExecutable {
    const exe = config.get<string>('executable', 'bugstalker');
    const logFile = config.get<string>('logFile');

    const args: string[] = ['--dap'];
    if (logFile) {
        args.push('--dap-log-file', logFile);
    }

    return new DebugAdapterExecutable(exe, args);
}
