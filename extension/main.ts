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

export const output = window.createOutputChannel('BugStalker');

export function activate(context: ExtensionContext): void {
    const subscriptions = context.subscriptions;

    const adapterFactory: DebugAdapterDescriptorFactory = {
        createDebugAdapterDescriptor: (_session, _executable) => {
            const cfg = workspace.getConfiguration('bugstalker');
            return getBugStalkerAdapterExecutable(cfg);
        },
    };

    subscriptions.push(
        debug.registerDebugAdapterDescriptorFactory('bugstalker', adapterFactory),
    );
    subscriptions.push(
        debug.registerDebugConfigurationProvider('bugstalker', new BugStalkerConfigProvider()),
    );
}

export function deactivate(): void {
    output.dispose();
}
