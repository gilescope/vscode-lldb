// Step-Into "just my code" commands (phase 12).
//
// DAP's `stepIn` carries no "modifier held" bit and VS Code's built-in
// `workbench.action.debug.stepInto` always sends a plain `stepIn`. So
// the alt / shift-alt distinction becomes two commands that each send
// the `bs/stepIn` custom request with an explicit `skipLibraries` flag.
// Using a custom request (rather than `stepIn`) keeps us out of VS
// Code's `stepIn` bookkeeping; the adapter answers it and emits the
// normal `stopped` event.
import { commands, debug, DebugSession, ExtensionContext } from 'vscode';
import { output } from './main';

export function registerStepInto(context: ExtensionContext): void {
    // `alt+right` (keybinding) — Step-In, skip libraries (just my code).
    register(context, 'bugstalker.stepIntoSkipLibs', true);
    register(context, 'lldb.stepIntoSkipLibs', true);
    // `shift+alt+right` (keybinding) — Step-In, any frame (classic).
    register(context, 'bugstalker.stepIntoAnyFrame', false);
    register(context, 'lldb.stepIntoAnyFrame', false);
}

function register(
    context: ExtensionContext,
    command: string,
    skipLibraries: boolean,
): void {
    context.subscriptions.push(
        commands.registerCommand(command, () => stepIn(skipLibraries)),
    );
}

async function stepIn(skipLibraries: boolean): Promise<void> {
    const session = debug.activeDebugSession;
    if (!session || !isBugStalkerSession(session)) return;
    try {
        await session.customRequest('bs/stepIn', { skipLibraries });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[stepInto] bs/stepIn (skipLibraries=${skipLibraries}) failed — ${msg}`);
    }
}

function isBugStalkerSession(session: DebugSession): boolean {
    return session.type === 'bugstalker' || session.type === 'lldb';
}
