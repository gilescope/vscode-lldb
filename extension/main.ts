// BugStalker VS Code extension entry point.
//
// Single debug type — `bugstalker` — backed by a stdio DAP adapter
// (`bugstalker --dap`). Cargo build integration is wired in via
// the `cargo` launch-config block.
import {
    debug,
    workspace,
    window,
    DebugAdapterDescriptorFactory,
    ExtensionContext,
} from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import {
    BugStalkerConfigProvider,
    getBugStalkerAdapterExecutable,
} from './novsc/bugstalker';
import { BugStalkerTrackerFactory } from './novsc/tracker';
import { registerEditContinue } from './editContinue';

const execFileAsync = promisify(execFile);

export const output = window.createOutputChannel('BugStalker');

export function activate(context: ExtensionContext): void {
    const subscriptions = context.subscriptions;

    void logVersionBanner(context);

    registerEditContinue(context);

    const adapterFactory: DebugAdapterDescriptorFactory = {
        createDebugAdapterDescriptor: (_session, _executable) => {
            const cfg = workspace.getConfiguration('bugstalker');
            return getBugStalkerAdapterExecutable(cfg, context);
        },
    };
    const trackerFactory = new BugStalkerTrackerFactory(output);

    // Register the adapter under both `bugstalker` (native type) and
    // `lldb` (CodeLLDB-compatible alias). The alias matters because
    // rust-analyzer detects this extension as `vadimcn.vscode-lldb`
    // (publisher.name in package.json) and, when its `Debug` CodeLens
    // is clicked, emits a launch config with `type: "lldb"` and calls
    // vscode.debug.startDebugging directly — no launch.json is read.
    // Without an `lldb` factory + provider registered here, the
    // session activates this extension and then dies with no adapter.
    const provider = new BugStalkerConfigProvider();
    for (const type of ['bugstalker', 'lldb'] as const) {
        subscriptions.push(
            debug.registerDebugAdapterDescriptorFactory(type, adapterFactory),
        );
        subscriptions.push(
            debug.registerDebugConfigurationProvider(type, provider),
        );
        subscriptions.push(
            debug.registerDebugAdapterTrackerFactory(type, trackerFactory),
        );
    }
}

export function deactivate(): void {
    output.dispose();
}

/// Print a header line so users can tell, from the BugStalker output
/// channel alone, which extension version is running and which `bs`
/// binary it will spawn (absolute path + `bs --version`). All three
/// answers are the first thing people need when triaging "bs died,
/// what was it even running" — make them impossible to miss.
async function logVersionBanner(context: ExtensionContext): Promise<void> {
    const extVersion: string =
        (context.extension?.packageJSON?.version as string | undefined) ?? '<unknown>';
    output.appendLine(`BugStalker extension v${extVersion}`);

    const cfg = workspace.getConfiguration('bugstalker');
    const bin = cfg.get<string>('executable', 'bs');
    output.appendLine(`bs (config): ${bin}`);

    const resolved = await resolveBsPath(bin);
    if (resolved) {
        output.appendLine(`bs (resolved): ${resolved}`);
    } else {
        output.appendLine(`bs (resolved): <not found on PATH>`);
    }

    try {
        const { stdout } = await execFileAsync(bin, ['--version']);
        const line = stdout.toString().trim() || '<empty output>';
        output.appendLine(`bs --version: ${line}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`bs --version: failed — ${msg}`);
    }
}

async function resolveBsPath(bin: string): Promise<string | undefined> {
    if (path.isAbsolute(bin)) return bin;
    try {
        const { stdout } = await execFileAsync('/usr/bin/which', [bin]);
        const first = stdout.toString().split('\n')[0]?.trim();
        return first && first.length > 0 ? first : undefined;
    } catch {
        return undefined;
    }
}
