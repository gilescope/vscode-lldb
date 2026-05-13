import {
    commands, debug, window, workspace,
    DebugConfiguration, DebugSession, ExtensionContext, Uri, WorkspaceFolder,
} from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { output } from './main';

interface EditContinueOptions {
    session: DebugSession;
    command: string;
    cwd: string;
    patchPath: string;
    watchGlobs: string[];
    debounceMs: number;
    base?: string | number;
}

interface EditContinueState extends EditContinueOptions {
    watchers: ReturnType<typeof workspace.createFileSystemWatcher>[];
    timer?: NodeJS.Timeout;
    running: boolean;
    pending: boolean;
    lastReason?: string;
}

type CargoConfig = {
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    filter?: {
        name?: string;
        kind?: string;
    };
};

let editContinue: EditContinueState | undefined;
const DEFAULT_DARWIN_TARGET = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

export function registerEditContinue(context: ExtensionContext) {
    context.subscriptions.push(commands.registerCommand('lldb.applyPatch', async () => {
        await applyPatchFromPicker();
    }));
    context.subscriptions.push(commands.registerCommand('lldb.startEditContinue', async () => {
        await startEditContinueFromCommand();
    }));
    context.subscriptions.push(commands.registerCommand('lldb.stopEditContinue', () => {
        stopEditContinue();
    }));

    // Compatibility aliases for the temporary BugStalker extension package.
    context.subscriptions.push(commands.registerCommand('bugstalker.applyPatch', async () => {
        await applyPatchFromPicker();
    }));
    context.subscriptions.push(commands.registerCommand('bugstalker.startEditContinue', async () => {
        await startEditContinueFromCommand();
    }));
    context.subscriptions.push(commands.registerCommand('bugstalker.stopEditContinue', () => {
        stopEditContinue();
    }));

    context.subscriptions.push({ dispose: () => stopEditContinue(false) });
    context.subscriptions.push(debug.onDidStartDebugSession(async session => {
        if (!isLldbSession(session)) {
            return;
        }
        if (shouldStartEditContinue(session.configuration)) {
            await startEditContinue(session, false);
        }
    }));
    context.subscriptions.push(debug.onDidTerminateDebugSession(session => {
        if (editContinue?.session.id == session.id) {
            stopEditContinue(false);
        }
    }));
}

/// True if `program` looks like the temp binary rust-analyzer's
/// "Debug" code lens produces — typically `/tmp/ra/debug/<binname>`
/// on macOS/Linux. RA puts these in its own `CARGO_TARGET_DIR` so
/// they don't collide with the user's `cargo build` artifacts. The
/// downside for EnC: the launched binary lives at one path while
/// the watcher's incremental rebuilds land in the project's normal
/// target dir — guaranteed 100% drift on every patch byte. We
/// detect this case and rebuild in the project's target dir before
/// launch, so launch and watcher agree.
function isRustAnalyzerTempProgram(program: unknown): boolean {
    if (typeof program != 'string') {
        return false;
    }
    const normalised = path.normalize(program);
    const sep = path.sep;
    return normalised.includes(`${sep}ra${sep}debug${sep}`);
}

/// When `program` points at rust-analyzer's temp build output and
/// EnC is enabled, rebuild the same binary in the project's normal
/// target dir using wild + our pinned RUSTFLAGS, then redirect
/// `debugConfig.program` at the project-target binary. This ensures
/// the launched process and the watcher's rebuilds share a target
/// dir and produce byte-identical artifacts.
///
/// Returns `true` if it took action (caller should not fall through
/// to other handlers), `false` if the launch wasn't a RA-temp case.
export async function configureEditContinueForRustAnalyzerTemp(
    folder: WorkspaceFolder | undefined,
    debugConfig: DebugConfiguration,
): Promise<boolean> {
    if (!editContinueEnabled(debugConfig)) {
        return false;
    }
    if (debugConfig.editContinueCommand) {
        return false;
    }
    if (!isRustAnalyzerTempProgram(debugConfig.program)) {
        return false;
    }

    const cargoCwd = expandConfigString(
        debugConfig.cwd ?? folder?.uri.fsPath ?? workspace.workspaceFolders?.[0]?.uri.fsPath,
        folder,
        debugConfig,
    );
    if (!cargoCwd) {
        output.appendLine(`[enc] RA-temp redirect skipped: no cargo cwd resolvable from launch config`);
        return false;
    }

    const binName = path.basename(debugConfig.program);
    const patchPath =
        expandConfigString(
            debugConfig.editContinuePatchPath ?? `${cargoCwd}/target/bugstalker.wild-patch`,
            folder,
            debugConfig,
        ) ?? `${cargoCwd}/target/bugstalker.wild-patch`;
    const target = debugConfig.editContinueTarget ?? defaultEditContinueTarget();
    const linker = resolveEditContinueLinker(debugConfig, cargoCwd);
    const cargoArgs = ensureCargoTarget(['build', '--bin', binName], target);

    debugConfig.editContinuePatchPath = patchPath;
    debugConfig._bugstalkerCargoArgs = cargoArgs;
    debugConfig._bugstalkerCargoCwd = cargoCwd;
    debugConfig._bugstalkerEditContinueLinker = linker;
    debugConfig._bugstalkerEditContinueTarget = target;
    debugConfig._bugstalkerEditContinueAutoConfigured = true;

    const prebuilt = await prebuildEditContinueBinary(debugConfig);
    if (!prebuilt) {
        output.appendLine(`[enc] RA-temp redirect: prebuild failed; leaving program at ${debugConfig.program} (drift expected on patch apply)`);
        return false;
    }
    output.appendLine(`[enc] RA-temp redirect: ${debugConfig.program} → ${prebuilt} (now matches watcher target dir)`);
    debugConfig.program = prebuilt;
    return true;
}

/// Build the EnC debuggee ourselves, ahead of CodeLLDB's own cargo
/// flow, and return the absolute path of the resulting executable.
///
/// **Why we duplicate the work**: CodeLLDB's `cargo.resolveCargoConfig`
/// passes `cargo.env` through to its spawned cargo, but in practice
/// the launched binary and the watcher's incremental rebuilds have
/// landed on different cargo hashes — symptom: `apply-patch` reports
/// 100% drift because the running process and wild's incremental
/// baseline are two completely different binaries with different
/// segment layouts. The exact divergence (different rustc inputs,
/// different config-file precedence, a stale `RUSTFLAGS` env var the
/// user has globally set, …) is hard to pin down. We sidestep it by
/// running the *exact same* cargo invocation the watcher would and
/// using its artifact directly.
///
/// Returns the executable path on success, or `undefined` (after
/// logging) on any failure — the caller falls back to CodeLLDB's
/// cargo flow.
export async function prebuildEditContinueBinary(
    debugConfig: DebugConfiguration,
): Promise<string | undefined> {
    const cargoCwd: string | undefined = debugConfig._bugstalkerCargoCwd;
    const cargoArgs: string[] | undefined = debugConfig._bugstalkerCargoArgs;
    const target: string | undefined = debugConfig._bugstalkerEditContinueTarget;
    const patchPath: string | undefined = debugConfig.editContinuePatchPath;

    if (!cargoCwd || !cargoArgs || !target || !patchPath) {
        return undefined;
    }

    const rustflags = editContinueRustflags(debugConfig, patchPath, cargoCwd);
    const envName = cargoTargetRustflagsEnv(target);

    // Full env: process.env (so PATH, HOME, etc. are present) plus
    // our pinned RUSTFLAGS. We also strip any user-set `RUSTFLAGS`
    // from the env, because per cargo's precedence rules a plain
    // `RUSTFLAGS` overrides `CARGO_TARGET_<triple>_RUSTFLAGS` and
    // would silently take wild out of the picture.
    const env = { ...process.env, [envName]: rustflags };
    delete (env as any).RUSTFLAGS;
    delete (env as any).CARGO_ENCODED_RUSTFLAGS;

    // Inject `--message-format=json` so we can pluck the executable
    // path out of cargo's stream. Insert before any `--` separator.
    const args = cargoArgs.slice();
    if (!args.includes('--message-format=json')) {
        const sep = args.indexOf('--');
        if (sep >= 0) {
            args.splice(sep, 0, '--message-format=json');
        } else {
            args.push('--message-format=json');
        }
    }

    output.appendLine(`[enc] prebuild: cargo ${args.join(' ')} (cwd=${cargoCwd}, ${envName}=${rustflags})`);

    return new Promise(resolve => {
        let executable: string | undefined;
        const cargo = cp.spawn('cargo', args, { cwd: cargoCwd, env });
        cargo.on('error', err => {
            output.appendLine(`[enc] prebuild failed to spawn cargo: ${err.message}`);
            resolve(undefined);
        });
        cargo.stderr.on('data', chunk => output.append(chunk.toString()));
        let stdoutBuf = '';
        cargo.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            let nl;
            while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, nl);
                stdoutBuf = stdoutBuf.slice(nl + 1);
                if (!line.startsWith('{')) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.reason === 'compiler-artifact' && typeof msg.executable === 'string') {
                        executable = msg.executable;
                    }
                } catch {
                    // ignore — non-JSON or partial line
                }
            }
        });
        cargo.on('exit', code => {
            if (code !== 0) {
                output.appendLine(`[enc] prebuild: cargo exited with code ${code}; falling back to CodeLLDB cargo flow`);
                resolve(undefined);
                return;
            }
            if (!executable) {
                output.appendLine(`[enc] prebuild: cargo finished but emitted no executable artifact; falling back to CodeLLDB cargo flow`);
                resolve(undefined);
                return;
            }
            output.appendLine(`[enc] prebuild: ready at ${executable} — using as debuggee program (cargo step bypassed)`);
            resolve(executable);
        });
    });
}

export function configureEditContinueCargo(
    folder: WorkspaceFolder | undefined,
    debugConfig: DebugConfiguration,
): void {
    if (!debugConfig.cargo || !editContinueEnabled(debugConfig) || debugConfig.editContinueCommand) {
        return;
    }
    const cargo = normalizeCargoConfig(debugConfig.cargo);
    if (!cargo) {
        return;
    }
    const originalArgs = cargo.args?.length ? cargo.args.map(String) : ['build'];
    const rebuildArgs = editContinueRebuildCargoArgs(originalArgs);
    if (!rebuildArgs) {
        if (editContinueExplicit(debugConfig)) {
            output.appendLine(`[enc] not auto-configuring unsupported cargo command: cargo ${originalArgs.join(' ')}`);
        }
        return;
    }

    const cargoCwd = expandConfigString(
        cargo.cwd ?? debugConfig.cwd ?? folder?.uri.fsPath ?? workspace.workspaceFolders?.[0]?.uri.fsPath,
        folder,
        debugConfig,
    );
    if (!cargoCwd) {
        return;
    }

    const patchPath = expandConfigString(
        debugConfig.editContinuePatchPath ?? `${cargoCwd}/target/bugstalker.wild-patch`,
        folder,
        debugConfig,
    ) ?? `${cargoCwd}/target/bugstalker.wild-patch`;
    const target = debugConfig.editContinueTarget ?? defaultEditContinueTarget();
    const linker = resolveEditContinueLinker(debugConfig, cargoCwd);
    const encConfig = {
        ...debugConfig,
        _bugstalkerEditContinueLinker: linker,
        _bugstalkerEditContinueTarget: target,
    };
    const envName = cargoTargetRustflagsEnv(target);
    const cargoEnv = { ...(cargo.env ?? {}) };
    cargoEnv[envName] = appendEnvValue(cargoEnv[envName], editContinueRustflags(encConfig, patchPath, cargoCwd));

    cargo.args = ensureCargoTarget(originalArgs, target);
    cargo.env = cargoEnv;
    debugConfig.cargo = cargo;
    debugConfig.editContinuePatchPath = patchPath;
    debugConfig._bugstalkerCargoArgs = ensureCargoTarget(rebuildArgs, target);
    debugConfig._bugstalkerCargoCwd = cargoCwd;
    debugConfig._bugstalkerEditContinueLinker = linker;
    debugConfig._bugstalkerEditContinueTarget = target;
    debugConfig._bugstalkerEditContinueAutoConfigured = true;
}

async function startEditContinueFromCommand(): Promise<void> {
    const session = debug.activeDebugSession;
    if (!session || !isLldbSession(session)) {
        window.showWarningMessage('Start an LLDB/BugStalker debug session before enabling edit-and-continue.');
        return;
    }
    await startEditContinue(session, true);
}

async function startEditContinue(
    session: DebugSession,
    allowPrompt: boolean,
): Promise<void> {
    const options = await getEditContinueOptions(session, allowPrompt);
    if (!options) {
        return;
    }
    stopEditContinue(false);

    const watchers = options.watchGlobs.map(glob => {
        const watcher = workspace.createFileSystemWatcher(glob);
        const schedule = (uri: Uri) => scheduleEditContinue(uri.fsPath);
        watcher.onDidCreate(schedule);
        watcher.onDidChange(schedule);
        return watcher;
    });

    editContinue = {
        ...options,
        watchers,
        running: false,
        pending: false,
    };
    output.appendLine(`[enc] watching ${options.watchGlobs.join(', ')}; command=${options.command}; patch=${options.patchPath}`);
    window.showInformationMessage('BugStalker edit-and-continue watcher started.');
}

function stopEditContinue(showMessage = true): void {
    if (editContinue?.timer) {
        clearTimeout(editContinue.timer);
    }
    for (const watcher of editContinue?.watchers ?? []) {
        watcher.dispose();
    }
    const hadWatcher = editContinue !== undefined;
    editContinue = undefined;
    if (showMessage && hadWatcher) {
        window.showInformationMessage('BugStalker edit-and-continue watcher stopped.');
    }
}

function scheduleEditContinue(reason: string): void {
    const state = editContinue;
    if (!state) {
        return;
    }
    if (isGeneratedBuildPath(reason)) {
        output.appendLine(`[enc] ignoring generated build file: ${reason}`);
        return;
    }
    state.lastReason = reason;
    if (state.timer) {
        clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
        void runEditContinue();
    }, state.debounceMs);
}

async function runEditContinue(): Promise<void> {
    const state = editContinue;
    if (!state) {
        return;
    }
    if (state.running) {
        state.pending = true;
        return;
    }

    state.running = true;
    try {
        do {
            state.pending = false;
            const reason = state.lastReason ?? 'source change';
            output.appendLine(`[enc] ${new Date().toISOString()} ${reason}`);
            output.appendLine(`[enc] running: ${state.command}`);
            window.setStatusBarMessage('BugStalker: rebuilding edit-and-continue patch...', 2000);

            removeStalePatch(state.patchPath);
            const result = await execShell(state.command, state.cwd);
            if (result.stdout) {
                output.append(result.stdout);
            }
            if (result.stderr) {
                output.append(result.stderr);
            }
            if (result.code != 0) {
                window.setStatusBarMessage('BugStalker: edit-and-continue build failed', 4000);
                output.show(true);
                return;
            }
            if (!fs.existsSync(state.patchPath)) {
                output.appendLine(`[enc] no patch emitted at ${state.patchPath}; keeping current debuggee unchanged`);
                const diagnostic = readPatchDiagnostic(state.patchPath);
                if (diagnostic) {
                    output.appendLine(`[enc] ${diagnostic}`);
                } else {
                    output.appendLine('[enc] no wild --emit-patch diagnostic sidecar found');
                }
                window.setStatusBarMessage('BugStalker: build succeeded, no patch emitted', 4000);
                return;
            }

            const response = await applyPatch(state.session, state.patchPath, false, state.base, false);
            if (response === undefined) {
                // applyPatch already logged + surfaced the failure.
                continue;
            }
            const entries = response?.entriesApplied ?? 0;
            const bytes = response?.bytesWritten ?? 0;
            const drift = response?.entriesSkippedDrift ?? 0;
            const readonly = response?.entriesSkippedReadonly ?? 0;
            const summary = `patched ${entries} entries, ${bytes} bytes, ${drift} skipped (drift), ${readonly} skipped (read-only)`;
            output.appendLine(`[enc] ${summary}`);
            const restartedFnStart = response?.restartedFrameFnStart;
            if (typeof restartedFnStart == 'number' || (restartedFnStart != null && restartedFnStart !== undefined)) {
                const fnHex = '0x' + Number(restartedFnStart).toString(16);
                output.appendLine(`[enc] auto-restarted top frame at ${fnHex} (patch landed in the currently-paused function)`);
            }
            const driftDetails: any[] = response?.driftDetails ?? [];
            if (driftDetails.length > 0) {
                output.appendLine(`[enc] drift: the running process's bytes don't match wild's "old bytes" — typical cause is a cargo-hash mismatch between what CodeLLDB launched and what the watcher rebuilt:`);
                for (const d of driftDetails) {
                    const sym = d.symbol ? ` ${d.symbol}` : '';
                    output.appendLine(`[enc]   offset 0x${Number(d.offset).toString(16)} (runtime 0x${Number(d.runtimeAddr).toString(16)})${sym}: expected ${d.expectedHex}, found ${d.actualHex}`);
                }
                if (drift > driftDetails.length) {
                    output.appendLine(`[enc]   ... ${drift - driftDetails.length} more drift entr${drift - driftDetails.length == 1 ? 'y' : 'ies'} not shown (capped at ${driftDetails.length})`);
                }
            }
            if (entries == 0 && drift == 0 && readonly == 0) {
                output.appendLine(`[enc] note: 0 entries applied — either the edited region produced no codegen change, or the wild patch was empty. Make a body-only edit (e.g. change a println! string) to force a real diff.`);
            }
            window.setStatusBarMessage(`BugStalker: ${summary}`, 4000);
        } while (state.pending);
    } finally {
        state.running = false;
    }
}

function removeStalePatch(patchPath: string): void {
    try {
        fs.unlinkSync(patchPath);
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code != 'ENOENT') {
            output.appendLine(`[enc] failed to remove stale patch ${patchPath}: ${err}`);
        }
    }
    try {
        fs.unlinkSync(patchDiagnosticPath(patchPath));
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code != 'ENOENT') {
            output.appendLine(`[enc] failed to remove stale patch diagnostic ${patchDiagnosticPath(patchPath)}: ${err}`);
        }
    }
}

function isGeneratedBuildPath(filePath: string): boolean {
    return filePath.split(path.sep).includes('target');
}

function readPatchDiagnostic(patchPath: string): string | undefined {
    try {
        const text = fs.readFileSync(patchDiagnosticPath(patchPath), 'utf8').trim();
        return text == '' ? undefined : text;
    } catch {
        return undefined;
    }
}

function patchDiagnosticPath(patchPath: string): string {
    return `${patchPath}.log`;
}

async function getEditContinueOptions(
    session: DebugSession,
    allowPrompt: boolean,
): Promise<EditContinueOptions | undefined> {
    const config = (session.configuration ?? {}) as DebugConfiguration;
    const workspaceFolder = session.workspaceFolder?.uri.fsPath ?? workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = expandConfigValue(
        config.editContinueCwd ?? config._bugstalkerCargoCwd ?? config.cwd ?? workspaceFolder,
        session,
    ) ?? workspaceFolder;

    let patchPath = expandConfigValue(config.editContinuePatchPath, session);
    if (!patchPath && cwd) {
        patchPath = `${cwd}/target/bugstalker.wild-patch`;
    }
    let command = expandConfigValue(config.editContinueCommand, session);
    if (!command && cwd && patchPath) {
        command = defaultEditContinueCommand(config, patchPath, cwd);
    }

    if (allowPrompt && !command) {
        command = await window.showInputBox({
            prompt: 'Command to incrementally compile/link and emit a BugStalker wild patch',
            placeHolder: 'cargo ... --emit-patch=/tmp/bugstalker.patch',
        });
    }
    if (allowPrompt && !patchPath) {
        patchPath = await window.showInputBox({
            prompt: 'Path to the wild patch emitted by your incremental linker',
            value: workspaceFolder ? `${workspaceFolder}/target/bugstalker.wild-patch` : undefined,
        });
    }
    if (!command || !patchPath || !cwd) {
        output.appendLine('[enc] not starting: missing command, patch path, or cwd');
        return undefined;
    }

    return {
        session,
        command,
        cwd,
        patchPath,
        watchGlobs: normalizeWatchGlobs(config.editContinueWatch),
        debounceMs: typeof config.editContinueDebounceMs == 'number' ? config.editContinueDebounceMs : 150,
        base: config.editContinueBase,
    };
}

function normalizeWatchGlobs(value: unknown): string[] {
    if (typeof value == 'string' && value.trim() != '') {
        return [value];
    }
    if (Array.isArray(value)) {
        const values = value.filter((item): item is string => typeof item == 'string' && item.trim() != '');
        if (values.length > 0) {
            return values;
        }
    }
    return ['**/*.rs'];
}

function defaultEditContinueCommand(config: DebugConfiguration, patchPath: string, cwd?: string): string {
    const cargoArgs = defaultCargoArgs(config);
    const target = config._bugstalkerEditContinueTarget ?? defaultEditContinueTarget();
    const args = ensureCargoTarget(cargoArgs.map((arg: unknown) => String(arg)), target)
        .map((arg: string) => shellQuote(arg))
        .join(' ');
    const rustflags = editContinueRustflags(config, patchPath, cwd);
    const envName = cargoTargetRustflagsEnv(target);
    return `${envName}=${shellQuote(rustflags)} cargo ${args}`;
}

function defaultCargoArgs(config: DebugConfiguration): string[] {
    if (Array.isArray(config._bugstalkerCargoArgs) && config._bugstalkerCargoArgs.length > 0) {
        return config._bugstalkerCargoArgs;
    }
    const program = typeof config.program == 'string' ? path.basename(config.program) : '';
    if (program && !program.includes('$') && program != '.' && !program.endsWith('.dylib')) {
        return ['build', '--bin', program];
    }
    return ['build'];
}

function defaultEditContinueTarget(): string {
    if (process.platform == 'darwin') {
        return DEFAULT_DARWIN_TARGET;
    }
    if (process.platform == 'linux' && process.arch == 'arm64') {
        return 'aarch64-unknown-linux-gnu';
    }
    if (process.platform == 'linux' && process.arch == 'x64') {
        return 'x86_64-unknown-linux-gnu';
    }
    return DEFAULT_DARWIN_TARGET;
}

function cargoTargetRustflagsEnv(target: string): string {
    return `CARGO_TARGET_${target.toUpperCase().replace(/-/g, '_')}_RUSTFLAGS`;
}

function ensureCargoTarget(args: string[], target: string): string[] {
    if (args.some(arg => arg == '--target' || arg.startsWith('--target='))) {
        return args;
    }
    const separator = args.indexOf('--');
    if (separator >= 0) {
        return [
            ...args.slice(0, separator),
            '--target',
            target,
            ...args.slice(separator),
        ];
    }
    return [...args, '--target', target];
}

function editContinueRebuildCargoArgs(cargoArgs: string[]): string[] | undefined {
    const separator = cargoArgs.indexOf('--');
    const args = separator >= 0 ? cargoArgs.slice(0, separator) : cargoArgs.slice();
    const commandIndex = args.findIndex(arg => !arg.startsWith('-'));
    if (commandIndex < 0) {
        return ['build'];
    }

    switch (args[commandIndex]) {
        case 'build':
            return args;
        case 'run':
            args[commandIndex] = 'build';
            return args;
        case 'test':
            if (!args.includes('--no-run')) {
                args.push('--no-run');
            }
            return args;
        default:
            return undefined;
    }
}

function editContinueRustflags(config: DebugConfiguration, patchPath: string, cwd?: string): string {
    const linker = resolveEditContinueLinker(config, cwd);
    return [
        '-C',
        'symbol-mangling-version=v0',
        '-C',
        'linker=clang',
        '-C',
        `link-arg=-fuse-ld=${linker}`,
        '-C',
        'link-arg=-Wl,--incremental-cache=read-write',
        '-C',
        `link-arg=-Wl,--emit-patch=${patchPath}`,
    ].join(' ');
}

function resolveEditContinueLinker(config: DebugConfiguration, cwd?: string): string {
    const configured = config.editContinueLinker ?? config._bugstalkerEditContinueLinker ?? process.env.WILD_LINKER;
    if (typeof configured == 'string' && configured.trim() != '') {
        return configured.split('${cwd}').join(cwd ?? '');
    }
    for (const candidate of wildLinkerCandidates(cwd)) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return 'wild';
}

function wildLinkerCandidates(cwd?: string): string[] {
    if (!cwd) {
        return [];
    }
    const candidates: string[] = [];
    let dir = path.resolve(cwd);
    for (;;) {
        candidates.push(path.join(dir, 'rec', 'linker', 'target', 'release', 'wild'));
        candidates.push(path.join(dir, 'rec', 'linker', 'target', 'debug', 'wild'));
        candidates.push(path.join(dir, 'linker', 'target', 'release', 'wild'));
        candidates.push(path.join(dir, 'linker', 'target', 'debug', 'wild'));
        candidates.push(path.join(dir, 'linker', 'ld'));
        candidates.push(path.join(dir, 'wild', 'target', 'release', 'wild'));
        candidates.push(path.join(dir, 'wild', 'target', 'debug', 'wild'));
        const parent = path.dirname(dir);
        if (parent == dir) {
            break;
        }
        dir = parent;
    }
    return candidates;
}

function normalizeCargoConfig(cargo: unknown): CargoConfig | undefined {
    if (Array.isArray(cargo)) {
        return { args: cargo.map(String) };
    }
    if (typeof cargo == 'object' && cargo != null) {
        const existing = cargo as CargoConfig;
        return {
            ...existing,
            args: Array.isArray(existing.args) ? existing.args.map(String) : existing.args,
            env: existing.env ? { ...existing.env } : undefined,
            filter: existing.filter ? { ...existing.filter } : undefined,
        };
    }
    return undefined;
}

function editContinueEnabled(config: DebugConfiguration): boolean {
    return config.editContinue !== false;
}

function editContinueExplicit(config: DebugConfiguration): boolean {
    return config.editContinue === true;
}

function shouldStartEditContinue(config: DebugConfiguration): boolean {
    // Default-on: any LLDB session attempts edit-and-continue unless the
    // user explicitly opts out with `"editContinue": false` in launch.json.
    // If we can't figure out how to rebuild (no cargo, no explicit command,
    // no resolvable cwd) `getEditContinueOptions` returns undefined and we
    // log a single line — see runEditContinue / startEditContinue.
    return editContinueEnabled(config);
}

function appendEnvValue(existing: string | undefined, addition: string): string {
    if (!existing || existing.trim() == '') {
        return addition;
    }
    return `${existing} ${addition}`;
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function expandConfigValue(value: unknown, session: DebugSession): string | undefined {
    if (typeof value != 'string') {
        return undefined;
    }
    const workspaceFolder = session.workspaceFolder?.uri.fsPath ?? workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const cwd = typeof session.configuration?.cwd == 'string' ? session.configuration.cwd : workspaceFolder;
    return value
        .split('${workspaceFolder}').join(workspaceFolder)
        .split('${workspaceRoot}').join(workspaceFolder)
        .split('${cwd}').join(cwd);
}

function expandConfigString(
    value: unknown,
    folder: WorkspaceFolder | undefined,
    config: DebugConfiguration,
): string | undefined {
    if (typeof value != 'string') {
        return undefined;
    }
    const workspaceFolder = folder?.uri.fsPath ?? workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const cwd = typeof config.cwd == 'string' ? config.cwd : workspaceFolder;
    return value
        .split('${workspaceFolder}').join(workspaceFolder)
        .split('${workspaceRoot}').join(workspaceFolder)
        .split('${cwd}').join(cwd);
}

function execShell(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
    // Strip `RUSTFLAGS` / `CARGO_ENCODED_RUSTFLAGS` from the env we
    // hand to the child shell. cargo's config-precedence makes the
    // four flag sources mutually exclusive: a user-set `RUSTFLAGS`
    // (from `~/.zshrc` or similar) overrides our inline
    // `CARGO_TARGET_<triple>_RUSTFLAGS=...` and the watcher-rebuild
    // would silently fall off wild — producing the 100%-drift symptom
    // we hit when the launched binary and the watcher's incremental
    // baseline disagreed on segment layout.
    const cleanEnv = { ...process.env };
    delete (cleanEnv as any).RUSTFLAGS;
    delete (cleanEnv as any).CARGO_ENCODED_RUSTFLAGS;
    return new Promise(resolve => {
        cp.exec(command, { cwd, env: cleanEnv }, (error, stdout, stderr) => {
            const code =
                typeof (error as cp.ExecException | null)?.code == 'number'
                    ? ((error as cp.ExecException).code as number)
                    : error
                        ? 1
                        : 0;
            resolve({ code, stdout, stderr });
        });
    });
}

async function applyPatchFromPicker(): Promise<void> {
    const uri = await pickPatchFile();
    if (!uri) {
        return;
    }
    const session = debug.activeDebugSession;
    if (!session || !isLldbSession(session)) {
        window.showWarningMessage('Start an LLDB/BugStalker debug session before applying a patch.');
        return;
    }
    const response = await applyPatch(session, uri.fsPath, true);
    const entries = response?.entriesApplied ?? 0;
    const bytes = response?.bytesWritten ?? 0;
    const skipped = response?.entriesSkippedDrift ?? 0;
    window.showInformationMessage(`BugStalker applied patch: ${entries} entries, ${bytes} bytes, ${skipped} skipped.`);
}

async function pickPatchFile(): Promise<Uri | undefined> {
    const picks = await window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Use Patch',
        filters: {
            'Wild patch': ['patch', 'wild-patch', 'txt'],
            'All files': ['*'],
        },
    });
    return picks?.[0];
}

async function applyPatch(
    session: DebugSession,
    patchPath: string,
    showError: boolean,
    base?: string | number,
    verifyExecutableHash = true,
): Promise<any | undefined> {
    try {
        return await session.customRequest('bs/applyPatch', { path: patchPath, base, verifyExecutableHash });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`[enc] patch failed: ${message}`);
        if (showError) {
            window.showErrorMessage(`BugStalker patch failed: ${message}`);
        } else {
            window.setStatusBarMessage('BugStalker: patch failed', 4000);
            output.show(true);
        }
        return undefined;
    }
}

function isLldbSession(session: DebugSession): boolean {
    return session.type == 'lldb' || session.type == 'bugstalker';
}

export const __test = {
    editContinueRebuildCargoArgs,
    ensureCargoTarget,
    shouldStartEditContinue,
};
