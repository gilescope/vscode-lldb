// SPDX-License-Identifier: MIT
//
// Variables-view §1: bridge layer that turns the bugstalker.*
// custom DAP fields into visible glyphs / suffixes / tags inside
// VS Code's stock variables + stack-trace panes.
//
// The bugstalker side (variables-view §5.1–§5.6) emits a stack
// of custom fields on every Variable / StackFrame:
//
//   * bugstalker.storage         "stack" | "register" | "static_ro"
//                                 | "static_rw" | "tls" | "optimized"
//                                 | "unknown"
//   * bugstalker.points_to_heap  true (omitted when false)
//   * bugstalker.mutability      "ro" | "rw"
//   * bugstalker.byte_size       u64
//   * bugstalker.layout          { totalBytes, payloadBytes, paddingBytes }
//   * bugstalker.recursionCount  u32 (per-frame, only when ≥ 2)
//   * bugstalker.stackHealth     { frameCount, maxRecursion,
//                                  threadStackSize?, threadStackUsed?,
//                                  threadStackUsedPct? }
//
// VS Code's stock pane has no way to apply arbitrary CSS to
// rows. What it WILL render faithfully is the `value` / `name`
// strings the adapter sent. So we fold the glyphs into the `name`
// string before it reaches the client.
//
// IMPORTANT: decorations go into `name`, never `value`. The `value`
// field is what "Copy Value" copies and what VS Code feeds to the
// `evaluate` request (clipboard context) — putting a glyph there
// produces a corrupt clipboard and an "evaluate parse error: found
// '👻'" from the adapter. `name` is display-only here (the adapter
// sets no `evaluateName`, so the stock pane doesn't round-trip the
// name through `evaluate`). Keep `value` byte-for-byte as the adapter
// rendered it.
//
// Stack health and the threads-pane budget bar would ideally
// render as their own UI element; for v0 we route the
// stack-health snapshot to the BugStalker output channel so the
// user sees it on each stop. A custom WebView / TreeView is the
// follow-up (variables-view.md §7 — vscode-extension HSL row-
// background renderer).

import { OutputChannel } from 'vscode';
import { DapMessage, DapMessageTransform } from './dapTransform';

/**
 * Storage-class glyph vocabulary (variables-view §1.3). Maps
 * the bugstalker.storage string to its leading-glyph form.
 * Stays in lockstep with `StorageClass::as_dap_str` on the
 * bugstalker side.
 */
const STORAGE_GLYPH: Record<string, string> = {
    stack: '⬛', // ⬛
    register: '🟦', // 🟦
    static_ro: '⬜', // ⬜
    static_rw: '🟧', // 🟧
    tls: '🟣', // 🟣 (large purple circle — closest to the design's purple square)
    optimized: '👻', // 👻
    unknown: '',
};

const HEAP_OVERLAY = '↗'; // ↗

/**
 * Mutability indicator (variables-view §1.2). VS Code stock pane
 * can't paint row backgrounds, so we lean on
 * `presentationHint.attributes = ["readOnly"]` (which bugstalker
 * already emits for "ro" rows — that gets italics for free) and
 * additionally append a tiny suffix glyph for readers who
 * disabled italics or are on a theme that doesn't differentiate.
 */
const MUTABILITY_BADGE: Record<string, string> = {
    ro: '\u{1F512}\u{FE0E}', // 🔒︎ — text-style variant (no emoji presentation)
    rw: '',
};

/**
 * Plain-language meaning of each decoration glyph. The stock VS Code
 * variables pane has no per-row tooltip, so we print this legend to the
 * BugStalker output channel on session start (see `main.ts`) — the only
 * discoverability channel available until the custom TreeView lands
 * (variables-view.md §7). Keep in lockstep with `STORAGE_GLYPH`,
 * `HEAP_OVERLAY`, and `MUTABILITY_BADGE` above.
 */
const GLYPH_LEGEND: ReadonlyArray<readonly [string, string]> = [
    [STORAGE_GLYPH.stack, 'stack local'],
    [STORAGE_GLYPH.register, 'in a register'],
    [STORAGE_GLYPH.static_ro, 'static, read-only (.rodata)'],
    [STORAGE_GLYPH.static_rw, 'static, mutable (.data/.bss)'],
    [STORAGE_GLYPH.tls, 'thread-local'],
    [STORAGE_GLYPH.optimized, 'optimized away — value unavailable'],
    [HEAP_OVERLAY, 'points into the heap'],
    [MUTABILITY_BADGE.ro, 'read-only / immutable binding'],
];

/**
 * Lines describing the variable-decoration glyphs, for the session-start
 * banner. The glyphs are folded into each variable's *name*; this legend
 * is what tells the reader what they mean.
 */
export function glyphLegendLines(): string[] {
    return [
        'variable glyphs (shown on the name; value is left untouched):',
        ...GLYPH_LEGEND.map(([glyph, meaning]) => `  ${glyph}  ${meaning}`),
    ];
}

/**
 * Construct the transform stream that enhances DAP responses
 * with the variables-view §1 vocabulary. `output` receives the
 * stack-health pill on each stack-trace response.
 */
export function createVariablesEnhancer(
    output: OutputChannel,
): DapMessageTransform {
    return new DapMessageTransform(msg => mutateOnce(msg, output));
}

function mutateOnce(msg: DapMessage, output: OutputChannel): DapMessage | undefined {
    if (msg.type !== 'response' || msg.success !== true) {
        return undefined;
    }
    if (msg.command === 'variables') {
        return mutateVariablesResponse(msg);
    }
    if (msg.command === 'stackTrace') {
        return mutateStackTraceResponse(msg, output);
    }
    return undefined;
}

/**
 * Apply storage glyph + heap overlay + byte size + layout
 * waste tag to every variable in a `variables` response.
 */
function mutateVariablesResponse(msg: DapMessage): DapMessage {
    const variables: any[] = msg.body?.variables ?? [];
    for (const v of variables) {
        decorateVariable(v);
    }
    return msg;
}

function decorateVariable(v: any): void {
    // Decorate the NAME, not the value (see file header). Bail if the
    // adapter sent no usable name to fold glyphs into.
    if (typeof v?.name !== 'string') return;

    const storage = typeof v['bugstalker.storage'] === 'string'
        ? STORAGE_GLYPH[v['bugstalker.storage'] as string] ?? ''
        : '';
    const heap = v['bugstalker.points_to_heap'] === true ? HEAP_OVERLAY : '';
    const mutability = typeof v['bugstalker.mutability'] === 'string'
        ? MUTABILITY_BADGE[v['bugstalker.mutability'] as string] ?? ''
        : '';

    // Compose the prefix: <storage><heap-overlay><mutability> +
    // single space + original name. Empty fragments are skipped
    // so we don't get awkward leading spaces.
    const prefix = [storage + heap, mutability]
        .filter(s => s.length > 0)
        .join(' ');
    if (prefix.length > 0) {
        v.name = `${prefix}  ${v.name}`;
    }

    // Trailing: byte_size + layout-waste tag, appended to the name.
    const trailers: string[] = [];
    const byteSize = typeof v['bugstalker.byte_size'] === 'number'
        ? formatBytes(v['bugstalker.byte_size'] as number)
        : undefined;
    if (byteSize) {
        trailers.push(`(${byteSize})`);
    }
    const layout = v['bugstalker.layout'];
    if (
        layout &&
        typeof layout.totalBytes === 'number' &&
        typeof layout.paddingBytes === 'number' &&
        layout.totalBytes > 0
    ) {
        const wastePct = Math.min(
            100,
            Math.round((layout.paddingBytes / layout.totalBytes) * 100),
        );
        // Only surface the waste tag when it's actionable (≥ 25%
        // — the amberThresholdPct from variables-view §4). Below
        // that the trailing byte-size column tells the same story.
        if (wastePct >= 25) {
            trailers.push(`[${wastePct}% waste]`);
        }
    }
    if (trailers.length > 0) {
        v.name = `${v.name}  ${trailers.join(' ')}`;
    }
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) {
        const kb = n / 1024;
        return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
    }
    const mb = n / (1024 * 1024);
    return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Append `[rec N]` to repeated frames, and route the per-thread
 * stack-health pill to the BugStalker output channel.
 */
function mutateStackTraceResponse(
    msg: DapMessage,
    output: OutputChannel,
): DapMessage {
    const frames: any[] = msg.body?.stackFrames ?? [];
    for (const f of frames) {
        const rec = f?.['bugstalker.recursionCount'];
        if (typeof rec === 'number' && rec >= 2 && typeof f.name === 'string') {
            f.name = `${f.name}  [rec ${rec}]`;
        }
    }
    const health = msg.body?.['bugstalker.stackHealth'];
    if (health) {
        output.appendLine(formatStackHealth(health));
    }
    return msg;
}

/**
 * Single-line health summary printed to the output channel on
 * every stackTrace response (i.e. each stop). Format mirrors the
 * design doc's example: `frame: 12 KB · 38% of 2 MB stack`.
 *
 * `frame:` is omitted from v0 because per-frame size isn't
 * computed yet (deferred — variables-view §7). Once it lands we
 * append it at the front.
 */
function formatStackHealth(h: any): string {
    const parts: string[] = ['[stack-health]'];
    if (typeof h.threadStackUsed === 'number' && typeof h.threadStackSize === 'number') {
        const used = formatBytes(h.threadStackUsed);
        const total = formatBytes(h.threadStackSize);
        const pct = typeof h.threadStackUsedPct === 'number' ? `${h.threadStackUsedPct}%` : '?';
        parts.push(`thread: ${used} / ${total} (${pct})`);
    }
    if (typeof h.frameCount === 'number') {
        parts.push(`frames=${h.frameCount}`);
    }
    if (typeof h.maxRecursion === 'number' && h.maxRecursion >= 2) {
        parts.push(`recursion=${h.maxRecursion}`);
    }
    return parts.join(' ');
}
