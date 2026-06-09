// BugStalker source+assembly webview panel.
//
// Opens beside the Rust source editor. Each asm line is prefixed with its
// 1-based source line number so the cursor position in the source editor
// drives a smooth-scroll in the webview to the matching instructions.
// Shows the whole current function, not an arbitrary fixed window.

import {
    commands, debug, window, workspace,
    DebugAdapterTracker, DebugAdapterTrackerFactory,
    DebugSession, ExtensionContext,
    ViewColumn, WebviewPanel,
} from 'vscode';
import { output } from './main';
import { buildDisasmUpdate, propagateLines, type BsPerf } from './disasmData';
import { explainInstruction } from './asmDescribe';

// Wire types (DAP + webview) and the data-gathering live in disasmData.ts so the
// build path is unit-testable without VS Code. This file is the glue: panel
// lifecycle, the stop tracker, and the webview HTML.

interface WebviewCursor {
    type: 'cursor';
    line: number;   // 1-based
}

// ── Module-level state ─────────────────────────────────────────────────────

let panel: WebviewPanel | undefined;
let currentSourcePath: string | undefined;
let lastSession: DebugSession | undefined;
let lastThreadId: number | undefined;
// Whether the Source+ASM panel was the active editor — sampled the instant a
// stopped event arrives, before VS Code reveals the source line and steals
// focus. Drives focus-reclaim so instruction-stepping stays in the asm pane.
let asmPanelActive = false;
let lastUpdateSig = '';   // signature of the last posted instruction list (diagnostic)

// ── Registration ───────────────────────────────────────────────────────────

export function registerDisasmView(ctx: ExtensionContext): void {
    ctx.subscriptions.push(
        commands.registerCommand('bugstalker.openDisasmView', openDisasmView),
        commands.registerCommand('bugstalker.stepiNext', () => handleWebviewMessage({ type: 'stepi-next' })),
        commands.registerCommand('bugstalker.stepiInto', () => handleWebviewMessage({ type: 'stepi-into' })),
    );

    // Auto-open when a debug session starts (respects bugstalker.showAsmViewOnStart).
    ctx.subscriptions.push(
        debug.onDidStartDebugSession((session) => {
            if (session.type !== 'bugstalker' && session.type !== 'lldb') return;
            const cfg = workspace.getConfiguration('bugstalker');
            if (cfg.get<boolean>('showAsmViewOnStart', true)) {
                ensurePanelOpen();
            }
        }),
    );

    // Cursor in the source editor → scroll webview to matching instructions.
    ctx.subscriptions.push(
        window.onDidChangeTextEditorSelection((e) => {
            if (!panel) return;
            if (e.textEditor.document.languageId !== 'rust') return;
            if (e.textEditor.document.uri.scheme !== 'file') return;
            const line = (e.selections[0]?.active.line ?? 0) + 1;
            const msg: WebviewCursor = { type: 'cursor', line };
            void panel.webview.postMessage(msg);
        }),
    );

    const factory: DebugAdapterTrackerFactory = {
        createDebugAdapterTracker(session: DebugSession): DebugAdapterTracker {
            return {
                onDidSendMessage(m: { type?: string; event?: string; body?: { threadId?: number; bs_perf?: BsPerf; reason?: string } }) {
                    if (m.type !== 'event' || m.event !== 'stopped') return;
                    // Sample focus NOW — synchronously, before VS Code reveals
                    // the source and clears it.
                    const wasAsmActive = asmPanelActive;
                    void onStop(session, m.body?.threadId, m.body?.bs_perf);
                    if (shouldReclaimAsmFocus(wasAsmActive, m.body?.reason)) {
                        reclaimAsmFocus();
                    }
                },
            };
        },
    };
    for (const type of ['bugstalker', 'lldb'] as const) {
        ctx.subscriptions.push(debug.registerDebugAdapterTrackerFactory(type, factory));
    }
}

// ── Panel lifecycle ────────────────────────────────────────────────────────

function ensurePanelOpen(): void {
    if (panel) {
        panel.reveal(ViewColumn.Two, true);
        return;
    }
    panel = window.createWebviewPanel(
        'bugstalker.disasm',
        'Source + ASM',
        { viewColumn: ViewColumn.Two, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [], enableFindWidget: true },
    );
    panel.webview.html = webviewHtml();
    panel.onDidChangeViewState((e) => {
        asmPanelActive = e.webviewPanel.active;
        sendAsmFocus(debug.activeDebugSession, e.webviewPanel.active);
    });
    panel.onDidDispose(() => {
        asmPanelActive = false;
        sendAsmFocus(debug.activeDebugSession, false);
        panel = undefined;
    });
    // If we open (or reopen after a window reload) while already paused, render
    // the current stop now — otherwise the panel sits blank until the next step.
    void renderCurrent();
}

// ── Open command ───────────────────────────────────────────────────────────

async function openDisasmView(): Promise<void> {
    const srcEditor =
        window.activeTextEditor?.document.languageId === 'rust'
            ? window.activeTextEditor
            : window.visibleTextEditors.find((e) => e.document.languageId === 'rust');

    if (!srcEditor) {
        void window.showWarningMessage('BugStalker: focus a Rust source file first.');
        return;
    }
    currentSourcePath = srcEditor.document.uri.fsPath;
    ensurePanelOpen();
    output.appendLine(`[disasm] opened for ${currentSourcePath}`);
}

// ── Stop handler ───────────────────────────────────────────────────────────

async function onStop(session: DebugSession, threadId: number | undefined, perf?: BsPerf): Promise<void> {
    if (!panel) return;
    if (session.type !== 'bugstalker' && session.type !== 'lldb') return;
    lastSession = session;
    lastThreadId = threadId;
    // NB: do NOT re-sync asm focus here. The adapter's focus flag is owned by
    // onDidChangeViewState alone. Re-reading panel.active on every stop races
    // with preserveFocusHint and can clobber the flag to false mid-stepping,
    // reverting the next F10/F11 to line-stepping.

    const result = await buildDisasmUpdate(session, threadId, perf);
    if ('skip' in result) {
        // Why a blank panel — keeps the failure diagnosable instead of silent.
        output.appendLine(`[disasm] no render: ${result.skip}`);
        return;
    }
    // Diagnostic: did the instruction list change (full webview rebuild) or is
    // this a same-function step (cheap PC move)? A "rebuild" every step would
    // explain residual scroll jumpiness.
    const sig = result.update.instructions.length + '@' + (result.update.instructions[0]?.addr ?? '');
    output.appendLine(`[disasm] ${sig === lastUpdateSig ? 'same fn (move PC)' : 'new fn (rebuild)'} pc=${result.update.currentPc}`);
    lastUpdateSig = sig;
    void panel.webview.postMessage(result.update);
}

// Render the CURRENT stop without waiting for a stopped event — used when the
// panel opens (or is reopened after a window reload) while the debuggee is
// already paused, which otherwise leaves the panel blank until the next step.
async function renderCurrent(): Promise<void> {
    const session = debug.activeDebugSession;
    if (!session || (session.type !== 'bugstalker' && session.type !== 'lldb')) return;
    await onStop(session, lastThreadId);
}

// Tell the adapter whether the Source+ASM panel is focused, so F10/F11 step at
// instruction granularity while it's active (adapter field `asm_view_focused`).
// The session-type decision is split out into `asmFocusShouldSend` so it's
// unit-testable without a live session.
function sendAsmFocus(session: DebugSession | undefined, focused: boolean): void {
    if (session && asmFocusShouldSend(session.type)) {
        void session.customRequest('bs/setAsmFocus', { focused });
    }
}

/** Which debug session types get the asm-focus sync. Both the native
 *  `bugstalker` type and the CodeLLDB-compatible `lldb` alias (what RA's Debug
 *  codelens launches) — matching every other session-type check in this file. */
export function asmFocusShouldSend(sessionType: string): boolean {
    return sessionType === 'bugstalker' || sessionType === 'lldb';
}

/** Whether to pull focus back to the asm pane after a stop. Only when it was
 *  the active editor AND this stop came from a step — on a breakpoint / pause /
 *  exception the user expects to land in source, so we leave focus alone.
 *  preserveFocusHint should keep focus on the webview, but VS Code still
 *  activates the source group on a cross-column reveal, so we reclaim it. */
export function shouldReclaimAsmFocus(asmWasActive: boolean, stopReason: string | undefined): boolean {
    return asmWasActive && stopReason === 'step';
}

// Re-reveal the panel WITH focus, deferred past VS Code's own stop-handling
// (which reveals + focuses the source line this same tick). Keeps the user in
// the asm pane while instruction-stepping.
function reclaimAsmFocus(): void {
    if (!panel) return;
    const column = panel.viewColumn ?? ViewColumn.Two;
    setTimeout(() => {
        try { panel?.reveal(column, false); } catch { /* panel closed mid-step */ }
    }, 0);
}

// ── Instruction-step relay ─────────────────────────────────────────────────
// Called when the webview posts { type: 'stepi-next' | 'stepi-into' }.
// Forwards as a standard DAP next/stepIn with granularity:'instruction',
// the same request VS Code's Disassembly View sends when focused.

function handleWebviewMessage(msg: { type: string }): void {
    if (!lastSession) return;
    const threadId = lastThreadId ?? 1;
    if (msg.type === 'stepi-next') {
        void lastSession.customRequest('next', { threadId, granularity: 'instruction' });
    } else if (msg.type === 'stepi-into') {
        void lastSession.customRequest('stepIn', { threadId, granularity: 'instruction' });
    }
}

// ── Webview HTML ────────────────────────────────────────────────────────────

function webviewHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-editor-font-family, 'Menlo', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    line-height: 1.5;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    overflow-y: scroll;
  }

  #fn-name {
    position: sticky;
    top: 0;
    padding: 3px 8px;
    font-style: italic;
    font-size: 0.85em;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-editorGroup-border, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    z-index: 1;
  }

  /* Static efficiency summary bar (port-pressure floor + mix). */
  #pressure {
    position: sticky;
    top: 1.5em;
    padding: 2px 8px;
    font-size: 0.8em;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-editorGroup-border, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    z-index: 1;
  }
  #pressure .bottleneck { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  #pressure .warn { color: #e0af68; }

  /* One row per instruction */
  .row {
    display: flex;
    align-items: baseline;
    padding: 0 8px;
    gap: 0;
    white-space: nowrap;
  }
  .row:nth-child(2n) { background: rgba(128,128,128,0.04); }

  /* Current-line highlight: background on matching rows */
  .row.cursor-line {
    background: var(--vscode-editor-selectionHighlightBackground,
                    rgba(173,214,255,0.07));
  }
  /* Current PC row */
  .row.current-pc {
    background: rgba(229, 192, 123, 0.12);
  }

  /* Line-number column */
  .ln {
    min-width: 4ch;
    text-align: right;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    margin-right: 8px;
    flex-shrink: 0;
    user-select: none;
  }
  .ln.same { opacity: 0.3; }  /* repeated line = faded */

  /* Arrow indicator — ::before on .row avoids layout grid issues */
  .row::before {
    content: ' ';
    display: inline-block;
    width: 1.2ch;
    flex-shrink: 0;
    color: #e5c07b;
  }
  .row.current-pc::before { content: '►'; }

  /* Expensive-op marker — a warn glyph after the operands. */
  .warnflag { margin-left: 1ch; color: #e0af68; flex-shrink: 0; }

  /* Mnemonic + operands */
  .mnem { color: var(--vscode-debugTokenExpression-name, #9cdcfe); margin-right: 4px; }
  .ops  { color: var(--vscode-editor-foreground); }

  .empty {
    padding: 16px;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    font-style: italic;
  }

  /* Instruction tooltip — what the line does, plus live operand values. */
  #tip {
    position: fixed;
    z-index: 10;
    max-width: 42ch;
    padding: 6px 9px;
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #ccc);
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    font-size: 0.92em;
    line-height: 1.45;
    pointer-events: none;
    display: none;
  }
  #tip .tip-mnem { color: var(--vscode-debugTokenExpression-name, #9cdcfe); font-weight: 600; }
  #tip .tip-explain { margin-top: 3px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  #tip .tip-desc { margin-top: 2px; }
  #tip .tip-regs { margin-top: 5px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 4px; }
  #tip .tip-reg { white-space: nowrap; }
  #tip .tip-reg .r { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
  #tip .tip-reg .v { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  #tip .tip-regnote { opacity: 0.6; font-style: italic; margin-left: 0.5ch; }
  #tip .tip-unknown { font-style: italic; opacity: 0.7; }
  #tip .tip-note { margin-top: 5px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 4px; }
  #tip .tip-note.warn { color: #e0af68; }
  #tip .tip-note.info { opacity: 0.85; }
</style>
</head>
<body>
<div id="fn-name">—</div>
<div id="pressure"></div>
<div id="root"><p class="empty">Pause the debugger to see assembly.</p></div>
<div id="tip"></div>
<script>
(function() {
  let cursorLine = 0;
  let registers = {};   // live GPRs at the current stop ({ x0: "0x…", … })
  let currentPc = '';
  let lastSig = '';     // identifies the currently-rendered instruction list
  let rowByAddr = {};   // addr → row element, for O(1) PC moves (no DOM scan)
  let pcRow = null;     // the currently-highlighted row

  window.addEventListener('message', ({ data }) => {
    try {
      if (data.type === 'update') {
        registers = data.registers || {};
        currentPc = data.currentPc;
        document.getElementById('fn-name').textContent = data.fnName || '(function)';
        renderPressure(data.pressure, data.efficiency);
        // Stepping within the same function sends the same instruction list —
        // rebuilding the whole DOM there resets scroll to the top and makes the
        // view jump. Detect that and only move the PC highlight instead.
        const sig = data.instructions.length + '@' +
          (data.instructions[0] ? data.instructions[0].addr : '');
        if (sig === lastSig) {
          movePc(data.currentPc);                       // cheap: re-highlight + nudge
        } else {
          lastSig = sig;
          render(data.instructions, data.currentPc);    // new function: full rebuild
          keepPcVisible();
        }
      } else if (data.type === 'cursor') {
        cursorLine = data.line;
        applyCursorLine();
        // Scroll to first matching row without jarring snap.
        scrollToRow(document.querySelector('.cursor-line'), 'center');
      }
    } catch (e) {
      // A throw in the webview JS is otherwise invisible (no console, no
      // extension log) and silently leaves the panel blank. Surface it.
      const root = document.getElementById('root');
      if (root) {
        root.textContent = 'ASM render error: ' + (e && e.message ? e.message : e)
          + '\\n\\n' + (e && e.stack ? e.stack : '');
        root.className = 'empty';
      }
    }
  });

  function render(instructions, currentPc) {
    const root = document.getElementById('root');
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!instructions.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No instructions in range.';
      root.appendChild(p);
      return;
    }

    rowByAddr = {};
    pcRow = null;
    let lastLine = 0;
    instructions.forEach(ins => {
      const isCurrent = ins.addr === currentPc;
      const row = document.createElement('div');
      row.className = 'row' + (isCurrent ? ' current-pc' : '');
      row.dataset.srcLine = String(ins.srcLine);
      // Stash tooltip inputs on the row for the delegated hover handler.
      if (ins.desc) row.dataset.desc = ins.desc;
      if (ins.explain) row.dataset.explain = ins.explain;
      row.dataset.regs = JSON.stringify(ins.regs || []);
      row.dataset.addr = ins.addr;
      rowByAddr[ins.addr] = row;
      if (isCurrent) pcRow = row;

      // Line-number cell.
      const ln = document.createElement('span');
      ln.className = 'ln' + (ins.srcLine === lastLine ? ' same' : '');
      ln.textContent = ins.srcLine > 0 ? String(ins.srcLine) : '';
      if (ins.srcLine > 0) lastLine = ins.srcLine;
      row.appendChild(ln);

      // Split mnemonic from operands on the first whitespace run.
      const spaceIdx = ins.text.search(/\s/);
      const mnem = spaceIdx >= 0 ? ins.text.slice(0, spaceIdx) : ins.text;
      const ops  = spaceIdx >= 0 ? ins.text.slice(spaceIdx).trimStart() : '';

      const mnemEl = document.createElement('span');
      mnemEl.className = 'mnem';
      mnemEl.textContent = mnem;
      row.appendChild(mnemEl);

      if (ops) {
        const opsEl = document.createElement('span');
        opsEl.className = 'ops';
        opsEl.textContent = ops;
        row.appendChild(opsEl);
      }

      // Expensive-op warning glyph (div / fp-div / barrier). Stash notes for
      // the hover tooltip.
      const notes = ins.notes || [];
      row.dataset.notes = JSON.stringify(notes);
      if (notes.some(nt => nt.severity === 'warn')) {
        const w = document.createElement('span');
        w.className = 'warnflag';
        w.textContent = '⚠';
        row.appendChild(w);
      }

      root.appendChild(row);
    });

    // Re-apply cursor highlight after re-render.
    applyCursorLine();
  }

  function renderPressure(p, eff) {
    const bar = document.getElementById('pressure');
    if (!p || !p.nInstr) { bar.textContent = ''; return; }
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    // "⚙ best ≈ 0.5 IPC · bound: integer divide · 0% SIMD · measured 3.2× floor"
    bar.appendChild(document.createTextNode('⚙ best ≈ '));
    bar.appendChild(document.createTextNode(p.peakIpc.toFixed(1) + ' IPC'));
    bar.appendChild(document.createTextNode(' · bound: '));
    const b = document.createElement('span');
    b.className = 'bottleneck';
    b.textContent = p.bottleneckLabel;
    bar.appendChild(b);
    if (p.simdShare != null) {
      bar.appendChild(document.createTextNode(' · ' + Math.round(p.simdShare * 100) + '% SIMD'));
    }
    if (p.stackTraffic > 0) {
      const s = document.createElement('span');
      s.className = p.stackTraffic > p.nInstr * 0.25 ? 'warn' : '';
      s.textContent = ' · ' + p.stackTraffic + ' stack op' + (p.stackTraffic === 1 ? '' : 's');
      bar.appendChild(s);
    }
    let title = 'Static throughput model (Firestorm port table) — optimistic, '
      + 'ignores dependency-chain latency. "best" is the highest IPC this exact '
      + 'instruction mix allows; the bound is the execution port that caps it.';
    // Tier 3: measured-vs-floor (run regime only).
    if (eff) {
      bar.appendChild(document.createTextNode(' · '));
      const e = document.createElement('span');
      e.className = eff.bound === 'stalls' ? 'warn' : 'bottleneck';
      e.textContent = 'measured ' + eff.ratio.toFixed(1) + '× floor';
      bar.appendChild(e);
      title += '\\n\\nMeasured: ' + eff.verdict + ' (run-regime, approximate — assumes the run was dominated by this function).';
    }
    bar.title = title;
  }

  function applyCursorLine() {
    document.querySelectorAll('.row').forEach(el => {
      el.classList.toggle('cursor-line',
        cursorLine > 0 && el.dataset.srcLine == String(cursorLine));
    });
  }

  function scrollToRow(target, block = 'center') {
    if (target) target.scrollIntoView({ behavior: 'smooth', block });
  }

  // Stepping within the same function: just move the current-PC highlight to the
  // new address and nudge it into view only if it's drifted off-screen — no DOM
  // rebuild, so the scroll position is preserved (no jump-to-top-and-back).
  // Move the PC highlight with the minimum possible work: un-highlight the old
  // row, highlight the new one (O(1) via the addr→row map — no DOM scan, no
  // rebuild). The ONLY visible change is the highlight, unless the new PC would
  // be off-screen (keepPcVisible decides).
  function movePc(pc) {
    if (pcRow) pcRow.classList.remove('current-pc');
    pcRow = rowByAddr[pc] || null;
    if (!pcRow) return;
    pcRow.classList.add('current-pc');
    keepPcVisible();
  }

  // Scroll ONLY when the PC isn't fully visible (off the bottom, or hidden under
  // the sticky header). While it's on screen we do nothing — stepping is just
  // the highlight moving, zero view movement. When it must scroll, reposition
  // toward the FAR edge in the direction of travel, so there's almost a full
  // screen of runway before the next scroll (rare repositions, not constant
  // nudging). Stepping forward marches down; backward retreats into rows that
  // are already on screen, so backward rarely triggers this at all.
  function keepPcVisible() {
    if (!pcRow) return;
    const fn = document.getElementById('fn-name');
    const pr = document.getElementById('pressure');
    const headerH = (fn ? fn.offsetHeight : 0) + (pr ? pr.offsetHeight : 0);
    const runway = window.innerHeight * 0.15;     // land 15% from the edge
    const r = pcRow.getBoundingClientRect();
    if (r.bottom > window.innerHeight) {
      // stepping forward off the bottom → put the PC near the top
      pcRow.style.scrollMarginTop = (headerH + runway) + 'px';
      pcRow.scrollIntoView({ block: 'start' });
    } else if (r.top < headerH) {
      // stepping back above the header → put the PC near the bottom
      pcRow.style.scrollMarginBottom = runway + 'px';
      pcRow.scrollIntoView({ block: 'end' });
    }
  }

  // ── Instruction tooltip ────────────────────────────────────────────────
  // Delegated hover: describe what the line does, and — only on the current
  // PC row, where the values are actually live — each operand register's
  // value. Register values for any other row would be stale/wrong, so we
  // deliberately don't show them.
  const tip = document.getElementById('tip');

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function buildTip(row) {
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    const text = row.querySelector('.mnem');
    const mnem = text ? text.textContent : '';
    tip.appendChild(el('div', 'tip-mnem', mnem));
    // Concrete decode first ("w8 = w8 − 1, and update the condition flags").
    if (row.dataset.explain) {
      tip.appendChild(el('div', 'tip-explain', row.dataset.explain));
    }
    if (row.dataset.desc) {
      tip.appendChild(el('div', 'tip-desc', row.dataset.desc));
    } else if (!row.dataset.explain) {
      tip.appendChild(el('div', 'tip-desc tip-unknown', 'No description for this instruction.'));
    }
    // Efficiency notes (expensive-op flags) — static, valid on any row.
    let notes = [];
    try { notes = JSON.parse(row.dataset.notes || '[]'); } catch (e) {}
    for (const nt of notes) {
      tip.appendChild(el('div', 'tip-note ' + (nt.severity || 'info'), nt.text));
    }
    // Live operand values: current PC row only. Each operand is
    // { name, reg, width }: name is as-written (e.g. "w8"), reg is the 64-bit
    // key into the register map ("x8"), width is 32 for a "w" view. A "w"
    // register is the LOW 32 BITS of its "x" — show that, not the full 64-bit
    // value, and say so, so "tbnz w8, #0" doesn't look like it's testing x8.
    if (row.dataset.addr === currentPc) {
      let regs = [];
      try { regs = JSON.parse(row.dataset.regs || '[]'); } catch (e) {}
      const have = regs.filter(o => o && registers[o.reg] !== undefined);
      if (have.length) {
        const box = el('div', 'tip-regs');
        for (const o of have) {
          const full = registers[o.reg];
          let value = full, note = '';
          if (o.width === 32) {
            try { value = '0x' + (BigInt(full) & 0xffffffffn).toString(16); } catch (e) { value = full; }
            note = ' (low 32 bits of ' + o.reg + ')';
          }
          const line = el('div', 'tip-reg');
          line.appendChild(el('span', 'r', o.name));
          line.appendChild(document.createTextNode(' = '));
          line.appendChild(el('span', 'v', value));
          if (note) line.appendChild(el('span', 'tip-regnote', note));
          box.appendChild(line);
        }
        tip.appendChild(box);
      }
    }
  }

  function positionTip(ev) {
    const pad = 12;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = ev.clientY - r.height - pad;
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = Math.max(0, y) + 'px';
  }

  document.getElementById('root').addEventListener('mouseover', (ev) => {
    const row = ev.target.closest && ev.target.closest('.row');
    if (!row) return;
    buildTip(row);
    tip.style.display = 'block';
    positionTip(ev);
  });
  document.getElementById('root').addEventListener('mousemove', (ev) => {
    if (tip.style.display === 'block') positionTip(ev);
  });
  document.getElementById('root').addEventListener('mouseout', (ev) => {
    const to = ev.relatedTarget;
    if (to && to.closest && to.closest('.row')) return; // moved within rows
    tip.style.display = 'none';
  });
})();
</script>
</body>
</html>`;
}

// Exposed for the @vscode/test-electron suite — the data-gathering path is
// tested through the activated extension API so the test stays within its
// rootDir (no direct source import). See extension/test/disasmData.test.ts.
export const _disasmTest = {
    buildUpdate: buildDisasmUpdate,
    propagateLines,
    webviewHtml,
    asmFocusShouldSend,
    shouldReclaimAsmFocus,
    explainInstruction,
};
