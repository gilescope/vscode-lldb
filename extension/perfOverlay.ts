// BugStalker performance-overlay client.
//
// Mirrors editContinue.ts in shape. On every stop, queries the DAP
// server's `bs/perfOverlay` custom request for each visible Rust
// editor and paints a heat-coloured square in the gutter on lines with
// non-zero sample counts. Hover shows samples + share. The per-stop
// summary that the adapter attaches to StoppedEvent.body.bs_perf
// drives a status-bar item.
//
// The Rust side is `bs-perf` (bugstalker/crates/bs-perf), wired into
// the DAP session at `src/dap/yadap/session/perf.rs`.

import {
    debug, window, Uri,
    DecorationOptions, DebugAdapterTracker, DebugAdapterTrackerFactory,
    DebugSession, ExtensionContext,
    OverviewRulerLane, Range, StatusBarAlignment, StatusBarItem,
    TextEditor, TextEditorDecorationType,
} from 'vscode';
import { output } from './main';

// Heat buckets keyed off the `heat` field returned by bs/perfOverlay,
// which is samples-on-this-line / samples-on-hottest-line-in-this-source.
// Four tiers keep the gutter readable without turning into a rainbow:
//   - cold, warm, hot, hottest
// Colours are tuned to be visible on both dark and light themes.
const HEAT_TIERS: ReadonlyArray<{ readonly max: number; readonly colour: string }> = [
    { max: 0.25, colour: '#7aa2f7' }, // cold — blue
    { max: 0.50, colour: '#e0af68' }, // warm — amber
    { max: 0.75, colour: '#ff9e64' }, // hot — orange
    { max: 1.01, colour: '#f7768e' }, // hottest — red-pink
];

// Field names mirror the DAP JSON wire format from the BugStalker
// adapter (src/dap/yadap/session/perf.rs), which is camelCase
// throughout. Keep these names exact — the previous snake_case
// shape silently produced undefined reads on every status update.
interface PerfOverlayLine {
    line: number;          // one-based
    sampleCount: number;
    sampleShare: number;   // 0..1
    heat: number;          // 0..1
    hottest: boolean;
}

interface PerfOverlayResponse {
    source: string;
    lines: PerfOverlayLine[];
    totalResolvedSamples: number;
    unresolvedSamples: number;
}

// Mode the adapter is collecting under. Drives the tooltip label
// so users can tell whether the gutter heat-map is supposed to be
// populated. Unknown values are tolerated and rendered verbatim.
type PerfMode =
    | 'linux-cycles'
    | 'macos-poll'
    | 'macos-rusage-only'
    | 'disabled'
    | string;

interface PerfDiagnosis {
    emoji: string;
    label: string;
    summary: string;
    hint: string;
}

interface PerfStoppedSummary {
    // Server may omit when running against an older BugStalker
    // build that pre-dates the `mode` field; fall back to deriving
    // from runCycles / runCpuTimeNs in that case.
    mode?: PerfMode;
    runCycles: number;
    runWallNs: number;
    // Tier 2 macOS path returns CPU time (ns) instead of raw cycles.
    // Linux cycles+IP leaves this null. Render as a fallback when
    // runCycles is zero.
    runCpuTimeNs: number | null;
    // Retired instructions during the window. macOS populates this
    // from rusage_info_v4.ri_instructions on macOS 13+. Linux will
    // populate from PERF_COUNT_HW_INSTRUCTIONS once that lands.
    runInstructions?: number | null;
    // Instructions ÷ cycles. Server-computed when both counters are
    // present; omitted otherwise.
    ipc?: number | null;
    // Emoji-coded root-cause hint in the rustc-helpful-error tradition.
    // Null on stops too short to diagnose.
    diagnosis?: PerfDiagnosis | null;
    hot?: {
        source: string;
        line: number;
        sampleCount: number;
        sampleShare: number;
    };
    unresolvedSamples: number;
}

interface SessionState {
    session: DebugSession;
    statusItem: StatusBarItem;
    // One decoration type per heat tier, indexed by tier number 0..N-1.
    decorations: TextEditorDecorationType[];
    // Per-file last-known overlay, keyed by editor document fsPath.
    fileCache: Map<string, PerfOverlayLine[]>;
    // Generation counter — bumped on every stop so stale async requests
    // can detect they've been overtaken and bail out before painting.
    generation: number;
    enabled: boolean;
}

let active: SessionState | undefined;

export function registerPerfOverlay(ctx: ExtensionContext): void {
    const factory: DebugAdapterTrackerFactory = {
        createDebugAdapterTracker(session: DebugSession): DebugAdapterTracker {
            return makeTracker(session);
        },
    };
    for (const type of ['bugstalker', 'lldb'] as const) {
        ctx.subscriptions.push(debug.registerDebugAdapterTrackerFactory(type, factory));
    }

    ctx.subscriptions.push(debug.onDidStartDebugSession(onSessionStart));
    ctx.subscriptions.push(debug.onDidTerminateDebugSession(onSessionEnd));
    ctx.subscriptions.push(window.onDidChangeActiveTextEditor(() => {
        // When the user opens a previously-unrequested file, fetch its
        // overlay; otherwise repaint from cache.
        void repaintAllVisible();
    }));
    ctx.subscriptions.push(window.onDidChangeVisibleTextEditors(() => {
        void repaintAllVisible();
    }));
    ctx.subscriptions.push({ dispose: () => teardown() });
}

function isBugStalkerSession(session: DebugSession): boolean {
    return session.type === 'bugstalker' || session.type === 'lldb';
}

function shouldEnable(cfg: { perfOverlay?: boolean }): boolean {
    // Default on. Opt out per-launch with `"perfOverlay": false`.
    return cfg.perfOverlay !== false;
}

async function onSessionStart(session: DebugSession): Promise<void> {
    if (!isBugStalkerSession(session)) return;
    if (!shouldEnable(session.configuration as { perfOverlay?: boolean })) return;
    if (active) teardown(); // one overlay at a time

    const statusItem = window.createStatusBarItem(StatusBarAlignment.Right, 90);
    statusItem.text = 'perf: -';
    statusItem.tooltip = 'BugStalker performance overlay';
    statusItem.show();

    active = {
        session,
        statusItem,
        decorations: HEAT_TIERS.map((tier) => buildDecorationType(tier.colour)),
        fileCache: new Map(),
        generation: 0,
        enabled: false,
    };

    try {
        // bs answers with { enabled, unavailable?, intelPt?, kperf? }. A
        // successful *request* doesn't mean collection is live: a bs built
        // without `--features perf` (or a platform/permission shortfall)
        // replies enabled:false with a reason in `unavailable`. Surface that
        // — otherwise the status bar sits at the initial 'perf: -' with no clue.
        const resp = (await session.customRequest('bs/perfOverlayEnable', {})) as
            | { enabled?: boolean; unavailable?: string | null }
            | undefined;
        if (resp?.enabled) {
            active.enabled = true;
            output.appendLine('[perf] overlay enabled');
        } else {
            const why = resp?.unavailable ?? 'adapter reported perf overlay unavailable (no reason given)';
            output.appendLine(`[perf] overlay unavailable — ${why}`);
            active.statusItem.tooltip = `BugStalker performance overlay unavailable — ${why}`;
        }
    } catch (err) {
        output.appendLine(`[perf] enable failed: ${formatErr(err)}`);
        // Keep the state object around — without enable we still pick
        // up StoppedEvent.body.bs_perf for the status bar.
    }
}

function onSessionEnd(session: DebugSession): void {
    if (active?.session.id !== session.id) return;
    teardown();
}

function teardown(): void {
    if (!active) return;
    for (const dt of active.decorations) {
        for (const editor of window.visibleTextEditors) {
            editor.setDecorations(dt, []);
        }
        dt.dispose();
    }
    active.statusItem.dispose();
    active = undefined;
}

function makeTracker(session: DebugSession): DebugAdapterTracker {
    return {
        onDidSendMessage: (m: { type?: string; event?: string; body?: { reason?: string; bs_perf?: PerfStoppedSummary } }) => {
            if (m.type !== 'event' || m.event !== 'stopped') return;
            if (active?.session.id !== session.id) return;
            const summary = m.body?.bs_perf;
            if (summary) updateStatus(summary);
            // Fetch fresh per-file overlays for every visible Rust file.
            active.generation += 1;
            const gen = active.generation;
            void refreshVisible(gen);
        },
    };
}

function updateStatus(summary: PerfStoppedSummary): void {
    if (!active) return;
    const parts: string[] = [];
    if (summary.diagnosis) {
        // Emoji leads the status — it's the cheapest signal of
        // "is this run interesting", visible without expanding the
        // tooltip.
        parts.push(summary.diagnosis.emoji);
    }
    parts.push(`perf ${formatCost(summary)}`);
    if (summary.runInstructions && summary.runInstructions > 0) {
        parts.push(`${formatScaled(summary.runInstructions, 'inst')}`);
    }
    if (summary.ipc && summary.ipc > 0) {
        parts.push(`IPC ${summary.ipc.toFixed(2)}`);
    }
    parts.push(formatDurationNs(summary.runWallNs));
    if (summary.hot) {
        const file = shortPath(summary.hot.source);
        const sharePct = (summary.hot.sampleShare * 100).toFixed(0);
        parts.push(`hot ${file}:${summary.hot.line} (${sharePct}%)`);
    }
    if (summary.unresolvedSamples > 0) {
        parts.push(`unresolved ${summary.unresolvedSamples}`);
    }
    active.statusItem.text = parts.join(' · ');
    active.statusItem.tooltip =
        `BugStalker perf — last run:\n` +
        `  mode:    ${describeMode(summary.mode)}\n` +
        formatCostLine(summary) +
        (summary.runInstructions && summary.runInstructions > 0
            ? `  inst:    ${summary.runInstructions.toLocaleString()} retired\n`
            : '') +
        (summary.ipc && summary.ipc > 0
            ? `  IPC:     ${summary.ipc.toFixed(3)} (instructions / cycles)\n`
            : '') +
        `  wall:    ${formatDurationNs(summary.runWallNs)}\n` +
        (summary.hot
            ? `  hot:     ${summary.hot.source}:${summary.hot.line} (${summary.hot.sampleCount} samples)\n`
            : '') +
        (summary.unresolvedSamples > 0
            ? `  unresolved: ${summary.unresolvedSamples} samples\n`
            : '') +
        (summary.diagnosis
            ? `\n${summary.diagnosis.emoji} ${summary.diagnosis.label}: ${summary.diagnosis.summary}\n` +
              `   ↳ ${summary.diagnosis.hint}\n`
            : '');
}

/// Human-readable expansion of the wire `mode` value. Unknown
/// values pass through verbatim so a newer adapter doesn't get
/// silently mis-described.
function describeMode(mode: PerfMode | undefined): string {
    switch (mode) {
        case 'linux-cycles':
            return 'Linux PMU cycles+IP';
        case 'macos-poll':
            return 'macOS polling sampler (~5% overhead)';
        case 'macos-rusage-only':
            return 'macOS rusage only — no gutter samples (codesign with com.apple.security.cs.debugger for the polling tier)';
        case 'disabled':
            return 'disabled';
        case undefined:
            return '(legacy adapter, mode unreported)';
        default:
            return mode;
    }
}

/// Status-bar cost cell. Prefer raw cycles (Linux PMU) when present,
/// otherwise the macOS Tier 2 CPU-time fallback, otherwise a dash so
/// the column is never blank.
function formatCost(summary: PerfStoppedSummary): string {
    if (summary.runCycles > 0) return formatCycles(summary.runCycles);
    if (summary.runCpuTimeNs && summary.runCpuTimeNs > 0) {
        return `${formatDurationNs(summary.runCpuTimeNs)} cpu`;
    }
    return '-';
}

/// Tooltip cost line. Spells out the unit so a 1.4 ms CPU-time
/// reading isn't mistaken for a 1.4 ms wall-clock reading.
function formatCostLine(summary: PerfStoppedSummary): string {
    if (summary.runCycles > 0) {
        return `  cycles: ${summary.runCycles.toLocaleString()}\n`;
    }
    if (summary.runCpuTimeNs && summary.runCpuTimeNs > 0) {
        return `  cpu:    ${formatDurationNs(summary.runCpuTimeNs)} (user + system, rusage)\n`;
    }
    return `  cycles: <unavailable>\n`;
}

async function refreshVisible(gen: number): Promise<void> {
    if (!active || !active.enabled) {
        // Without enable we can still try — server returns empty if disabled.
        if (!active) return;
    }
    const editors = window.visibleTextEditors.filter(rustEditor);
    await Promise.all(editors.map((ed) => refreshEditor(ed, gen)));
}

async function refreshEditor(editor: TextEditor, gen: number): Promise<void> {
    if (!active) return;
    const fsPath = editor.document.uri.fsPath;
    let response: PerfOverlayResponse | undefined;
    try {
        response = await active.session.customRequest('bs/perfOverlay', {
            source: fsPath,
            window: 'LastRun',
        }) as PerfOverlayResponse;
    } catch (err) {
        // perfOverlay is a best-effort surface. If the adapter doesn't
        // know the command (older build) or returns an error, log and
        // move on — the rest of the debugger keeps working.
        output.appendLine(`[perf] overlay request failed for ${fsPath}: ${formatErr(err)}`);
        return;
    }
    if (!active || active.generation !== gen) return; // overtaken
    active.fileCache.set(fsPath, response.lines);
    paint(editor, response.lines);
}

function repaintAllVisible(): void {
    if (!active) return;
    for (const editor of window.visibleTextEditors) {
        if (!rustEditor(editor)) continue;
        const cached = active.fileCache.get(editor.document.uri.fsPath);
        if (cached) {
            paint(editor, cached);
        } else if (active.enabled) {
            // Newly-visible editor — fetch its overlay.
            void refreshEditor(editor, active.generation);
        }
    }
}

function paint(editor: TextEditor, lines: PerfOverlayLine[]): void {
    if (!active) return;
    const buckets: DecorationOptions[][] = HEAT_TIERS.map((): DecorationOptions[] => []);
    for (const line of lines) {
        const tier = pickTier(line.heat);
        const zeroBased = Math.max(0, line.line - 1);
        const range = new Range(zeroBased, 0, zeroBased, 0);
        const sharePct = (line.sampleShare * 100).toFixed(1);
        const hot = line.hottest ? ' [hottest]' : '';
        buckets[tier].push({
            range,
            hoverMessage:
                `**BugStalker perf**${hot}\n\n` +
                `- samples: ${line.sampleCount}\n` +
                `- share:   ${sharePct}%\n` +
                `- heat:    ${(line.heat * 100).toFixed(0)}%`,
        });
    }
    for (let i = 0; i < HEAT_TIERS.length; i += 1) {
        editor.setDecorations(active.decorations[i], buckets[i]);
    }
}

function pickTier(heat: number): number {
    for (let i = 0; i < HEAT_TIERS.length; i += 1) {
        if (heat <= HEAT_TIERS[i].max) return i;
    }
    return HEAT_TIERS.length - 1;
}

function buildDecorationType(colour: string): TextEditorDecorationType {
    return window.createTextEditorDecorationType({
        gutterIconPath: heatSvgUri(colour),
        gutterIconSize: 'auto',
        overviewRulerColor: colour,
        overviewRulerLane: OverviewRulerLane.Right,
    });
}

// 16×16 SVG with a 4-wide vertical bar in the requested colour. Small
// enough to coexist with breakpoint icons; tall enough to read at a
// glance. Bundled as a data URI so the extension ships no image files.
function heatSvgUri(colour: string): Uri {
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>` +
        `<rect x='6' y='2' width='4' height='12' rx='1' ry='1' fill='${colour}'/>` +
        `</svg>`;
    const encoded = Buffer.from(svg, 'utf8').toString('base64');
    return Uri.parse(`data:image/svg+xml;base64,${encoded}`);
}

function rustEditor(editor: TextEditor): boolean {
    return editor.document.languageId === 'rust';
}

function shortPath(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
}

function formatCycles(cycles: number): string {
    return formatScaled(cycles, 'cy');
}

function formatScaled(value: number, unit: string): string {
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G ${unit}`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M ${unit}`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}k ${unit}`;
    return `${value} ${unit}`;
}

function formatDurationNs(ns: number): string {
    if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(1)} s`;
    if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`;
    if (ns >= 1_000) return `${Math.round(ns / 1_000)} us`;
    return `${ns} ns`;
}

function formatErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export const __test = {
    pickTier,
    formatCycles,
    formatDurationNs,
    HEAT_TIERS,
};
