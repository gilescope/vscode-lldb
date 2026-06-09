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
                onDidSendMessage(m: { type?: string; event?: string; body?: { threadId?: number; bs_perf?: BsPerf } }) {
                    if (m.type !== 'event' || m.event !== 'stopped') return;
                    void onStop(session, m.body?.threadId, m.body?.bs_perf);
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
        sendAsmFocus(debug.activeDebugSession, e.webviewPanel.active);
    });
    panel.onDidDispose(() => {
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
  #tip .tip-desc { margin-top: 2px; }
  #tip .tip-regs { margin-top: 5px; border-top: 1px solid rgba(128,128,128,0.25); padding-top: 4px; }
  #tip .tip-reg { white-space: nowrap; }
  #tip .tip-reg .r { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
  #tip .tip-reg .v { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
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

  window.addEventListener('message', ({ data }) => {
    try {
      if (data.type === 'update') {
        registers = data.registers || {};
        currentPc = data.currentPc;
        document.getElementById('fn-name').textContent = data.fnName || '(function)';
        renderPressure(data.pressure, data.efficiency);
        render(data.instructions, data.currentPc);
        // Scroll to the PC row after a render.
        scrollToRow(document.querySelector('.current-pc'));
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

    let lastLine = 0;
    instructions.forEach(ins => {
      const isCurrent = ins.addr === currentPc;
      const row = document.createElement('div');
      row.className = 'row' + (isCurrent ? ' current-pc' : '');
      row.dataset.srcLine = String(ins.srcLine);
      // Stash tooltip inputs on the row for the delegated hover handler.
      if (ins.desc) row.dataset.desc = ins.desc;
      row.dataset.regs = JSON.stringify(ins.regs || []);
      row.dataset.addr = ins.addr;

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
    if (row.dataset.desc) {
      tip.appendChild(el('div', 'tip-desc', row.dataset.desc));
    } else {
      tip.appendChild(el('div', 'tip-desc tip-unknown', 'No description for this instruction.'));
    }
    // Efficiency notes (expensive-op flags) — static, valid on any row.
    let notes = [];
    try { notes = JSON.parse(row.dataset.notes || '[]'); } catch (e) {}
    for (const nt of notes) {
      tip.appendChild(el('div', 'tip-note ' + (nt.severity || 'info'), nt.text));
    }
    // Live operand values: current PC row only.
    if (row.dataset.addr === currentPc) {
      let regs = [];
      try { regs = JSON.parse(row.dataset.regs || '[]'); } catch (e) {}
      const have = regs.filter(r => registers[r] !== undefined);
      if (have.length) {
        const box = el('div', 'tip-regs');
        for (const r of have) {
          const line = el('div', 'tip-reg');
          line.appendChild(el('span', 'r', r));
          line.appendChild(document.createTextNode(' = '));
          line.appendChild(el('span', 'v', registers[r]));
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
};
