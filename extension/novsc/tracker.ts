// DAP-traffic tracker for the BugStalker adapter.
//
// The extension's "BugStalker" output channel was historically empty
// because the adapter speaks DAP directly over stdio — VS Code routes
// the bytes between editor and `bs --dap` and the extension never
// sees them. This tracker plugs into VS Code's
// `DebugAdapterTrackerFactory` API so that the in/out DAP messages
// flow through here, and we mirror the interesting bits (breakpoint
// verification results, adapter errors, unexpected exits, output
// events, stop reasons) into the user-visible output channel.
//
// Goal: when a breakpoint silently fails to bind, or the adapter
// dies before answering `launch`, the user gets a single place to
// look for the cause instead of staring at a green DAP session that
// "ran but didn't stop".
import {
    DebugAdapterTracker,
    DebugAdapterTrackerFactory,
    DebugSession,
    OutputChannel,
} from 'vscode';

interface DAPMessage {
    type?: string;
    command?: string;
    event?: string;
    success?: boolean;
    message?: string;
    arguments?: any;
    body?: any;
}

export class BugStalkerTrackerFactory implements DebugAdapterTrackerFactory {
    constructor(private readonly out: OutputChannel) {}

    createDebugAdapterTracker(session: DebugSession): DebugAdapterTracker {
        const out = this.out;
        const tag = (level: string, msg: string) =>
            out.appendLine(`[${new Date().toISOString()}] ${level} ${msg}`);

        return {
            onWillStartSession: () => {
                tag('session', `start name=${JSON.stringify(session.name)} type=${session.type}`);
            },
            onWillReceiveMessage: (m: DAPMessage) => {
                if (m.type === 'request' && m.command === 'launch') {
                    const a = m.arguments ?? {};
                    tag('→ launch', `program=${a.program ?? '<unset>'} args=${JSON.stringify(a.args ?? [])} cwd=${a.cwd ?? '<unset>'}`);
                } else if (m.type === 'request' && m.command === 'attach') {
                    tag('→ attach', JSON.stringify(m.arguments ?? {}));
                } else if (m.type === 'request' && m.command === 'setBreakpoints') {
                    const a = m.arguments ?? {};
                    const lines = (a.breakpoints ?? []).map((bp: any) => bp.line).join(',');
                    tag('→ setBreakpoints', `source=${a.source?.path ?? '<unknown>'} lines=[${lines}]`);
                }
            },
            onDidSendMessage: (m: DAPMessage) => {
                if (m.type === 'response' && m.command === 'setBreakpoints') {
                    const bps = m.body?.breakpoints ?? [];
                    const summary = bps.map((bp: any, i: number) =>
                        `${i}:${bp.verified ? 'verified' : 'UNVERIFIED'}${bp.message ? `(${bp.message})` : ''}`,
                    ).join(' ');
                    tag('← setBreakpoints', `success=${m.success} ${summary}`);
                    if (bps.length > 0 && bps.every((bp: any) => !bp.verified)) {
                        out.show(true);
                    }
                } else if (m.type === 'response' && m.success === false) {
                    tag('← error', `${m.command}: ${m.message ?? '(no message)'}`);
                    out.show(true);
                } else if (m.type === 'event' && m.event === 'output') {
                    const cat = m.body?.category ?? 'console';
                    const line = (m.body?.output ?? '').replace(/\n$/, '');
                    if (line) tag(`output/${cat}`, line);
                } else if (m.type === 'event' && m.event === 'stopped') {
                    tag('event stopped', `reason=${m.body?.reason} thread=${m.body?.threadId} desc=${m.body?.description ?? ''}`);
                } else if (m.type === 'event' && m.event === 'continued') {
                    tag('event continued', `thread=${m.body?.threadId}`);
                } else if (m.type === 'event' && m.event === 'terminated') {
                    tag('event terminated', JSON.stringify(m.body ?? {}));
                } else if (m.type === 'event' && m.event === 'exited') {
                    tag('event exited', `exitCode=${m.body?.exitCode}`);
                }
            },
            onError: (err: Error) => {
                tag('adapter-error', err.stack ?? err.message);
                out.show(true);
            },
            onExit: (code: number | undefined, signal: string | undefined) => {
                tag('adapter-exit', `code=${code ?? 'null'} signal=${signal ?? 'null'}`);
                if (code !== 0 && code !== undefined) out.show(true);
            },
        };
    }
}
