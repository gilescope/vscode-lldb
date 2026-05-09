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
import {
    BugStalkerConfigProvider,
    getBugStalkerAdapterExecutable,
} from './novsc/bugstalker';
import { BugStalkerTrackerFactory } from './novsc/tracker';

export const output = window.createOutputChannel('BugStalker');

export function activate(context: ExtensionContext): void {
    const subscriptions = context.subscriptions;

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
