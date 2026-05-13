// Bridge to BugStalker's stdio DAP server. Selected by
// `"type": "bugstalker"` in launch.json.
//
// Why we spawn bs ourselves (instead of returning
// `DebugAdapterExecutable`): when VS Code spawns the adapter via
// `DebugAdapterExecutable`, **its stderr is discarded** — only stdin
// /stdout are wired through. Panics, `tracing` output, and the
// adapter's own diagnostic prints all vanish, leaving the user with
// "the debugger died and there's no log."
//
// Fix: spawn bs ourselves with all three streams piped, open a
// loopback TCP server, and bridge socket <-> bs.stdin/stdout. bs's
// stderr goes straight into the BugStalker output channel. Returning
// `DebugAdapterServer` instead of `DebugAdapterExecutable` is what
// lets VS Code connect via that loopback port.
//
// Default executable is `bs` — the binary name `cargo install
// bugstalker` produces (the package is `bugstalker` but the
// `[[bin]]` is `bs`). Override via the `bugstalker.executable`
// setting if your binary lives somewhere else.
import {
    CancellationToken,
    DebugAdapterDescriptor,
    DebugAdapterServer,
    DebugConfiguration,
    DebugConfigurationProvider,
    ExtensionContext,
    WorkspaceConfiguration,
    WorkspaceFolder,
    window,
    workspace,
} from 'vscode';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);
import stringArgv from 'string-argv';
import { Cargo, expandCargo } from '../cargo';
import { output } from '../main';
import { ensureBsEntitled } from './darwinSign';
import {
    configureEditContinueCargo,
    configureEditContinueForRustAnalyzerTemp,
    prebuildEditContinueBinary,
} from '../editContinue';

async function resolveAbsoluteExe(bin: string): Promise<string | undefined> {
    if (path.isAbsolute(bin)) return bin;
    try {
        const { stdout } = await execFileAsync('/usr/bin/which', [bin]);
        const first = stdout.toString().split('\n')[0]?.trim();
        return first && first.length > 0 ? first : undefined;
    } catch {
        return undefined;
    }
}

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
): Promise<DebugAdapterDescriptor> {
    const exe = config.get<string>('executable', 'bs');
    const logFile = config.get<string>('logFile') || defaultLogFile(context);
    const adapterEnv = config.get<{ [k: string]: string }>('adapterEnv', {});

    const args: string[] = ['--dap'];
    if (logFile) {
        args.push('--dap-log-file', logFile);
    }

    const resolvedExe = await resolveAbsoluteExe(exe);
    output.appendLine(
        `[${new Date().toISOString()}] adapter spawn exe=${exe}${
            resolvedExe && resolvedExe !== exe ? ` (resolved: ${resolvedExe})` : ''
        } args=${JSON.stringify(args)}`,
    );

    // Best-effort: ensure the macOS cs.debugger entitlement is in
    // place before spawning. Never throws — if signing fails, bs
    // starts anyway and surfaces its own descriptive error.
    await ensureBsEntitled(exe, output);

    const env: NodeJS.ProcessEnv = { ...process.env, ...adapterEnv };
    if (!env.RUST_BACKTRACE) env.RUST_BACKTRACE = '1';

    const child = spawn(exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
    });

    const stderrPrefix = '[bs] ';
    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        let nl: number;
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
            const line = stderrBuf.slice(0, nl);
            stderrBuf = stderrBuf.slice(nl + 1);
            output.appendLine(stderrPrefix + line);
        }
    });
    child.stderr.on('end', () => {
        if (stderrBuf.length > 0) {
            output.appendLine(stderrPrefix + stderrBuf);
            stderrBuf = '';
        }
    });

    child.on('error', err => {
        output.appendLine(`[bs] spawn error: ${err.message}`);
        output.show(true);
    });
    child.on('exit', (code, signal) => {
        output.appendLine(`[bs] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if ((code !== null && code !== 0) || signal) {
            output.show(true);
        }
    });

    const server = net.createServer(socket => {
        // Single client per session — stop accepting once VS Code
        // attaches. Closing the server early means
        // `server.close()` on shutdown only has to flush the listener.
        server.close();
        socket.on('error', err => output.appendLine(`[bs] socket error: ${err.message}`));

        if (!child.stdout || !child.stdin) {
            output.appendLine('[bs] child stdio unavailable; closing socket');
            socket.destroy();
            return;
        }
        child.stdout.pipe(socket);
        socket.pipe(child.stdin);

        const teardown = () => {
            if (!child.killed && child.exitCode === null) {
                try { child.kill(); } catch { /* already gone */ }
            }
        };
        socket.on('close', teardown);
        socket.on('end', teardown);
    });

    server.on('error', err => {
        output.appendLine(`[bs] bridge server error: ${err.message}`);
        output.show(true);
    });

    const port: number = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr === 'object' && addr) {
                resolve(addr.port);
            } else {
                reject(new Error('failed to bind loopback port for bs DAP bridge'));
            }
        });
    });

    // If bs dies before VS Code connects, fail loudly rather than
    // leaving VS Code hanging on the connect.
    child.once('exit', () => {
        try { server.close(); } catch { /* best effort */ }
    });

    return new DebugAdapterServer(port, '127.0.0.1');
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
            // Hand off to the EnC pipeline first when it can take
            // over the build — that path uses the wild linker and
            // pinned RUSTFLAGS so the launched binary matches what
            // the watcher will rebuild against. Falls back to the
            // plain cargo flow below if EnC doesn't fire (no `cargo`
            // block, EnC explicitly disabled, etc).
            configureEditContinueCargo(folder, launchConfig);
            let prebuilt: string | undefined;
            if (launchConfig._bugstalkerEditContinueAutoConfigured === true) {
                prebuilt = await prebuildEditContinueBinary(launchConfig);
            }
            if (prebuilt) {
                launchConfig.program = prebuilt;
                delete launchConfig.cargo;
            } else {
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
        } else {
            // No cargo block — but if `program` points at
            // rust-analyzer's temp build dir, rebuild in the project
            // target so launch+watcher artifacts agree.
            await configureEditContinueForRustAnalyzerTemp(folder, launchConfig);
        }

        return launchConfig;
    }
}
