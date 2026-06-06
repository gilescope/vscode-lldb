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
    Uri, ViewColumn, WebviewPanel,
} from 'vscode';
import { output } from './main';

// ── DAP wire types ─────────────────────────────────────────────────────────

interface DapInstruction {
    address: string;
    instruction: string;
    location?: { path?: string };
    line?: number;
}

interface DapStackFrame {
    source?: { path?: string };
    line?: number;
    instructionPointerReference?: string;
}

interface FunctionBoundsResponse {
    startAddress?: string;
    endAddress?: string;
    unavailable?: boolean;
}

// ── Wire type sent to webview ──────────────────────────────────────────────

interface WvInstruction {
    srcLine: number;    // 1-based; 0 = no source info
    text: string;       // mnemonic + operands (no address)
    addr: string;       // normalised hex, for PC comparison
}

interface WebviewUpdate {
    type: 'update';
    instructions: WvInstruction[];
    currentPc: string;
    fnName: string;
}

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
                onDidSendMessage(m: { type?: string; event?: string; body?: { threadId?: number } }) {
                    if (m.type !== 'event' || m.event !== 'stopped') return;
                    void onStop(session, m.body?.threadId);
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
    panel.onDidDispose(() => { panel = undefined; });
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

async function onStop(session: DebugSession, threadId: number | undefined): Promise<void> {
    if (!panel) return;
    if (session.type !== 'bugstalker' && session.type !== 'lldb') return;
    lastSession = session;
    lastThreadId = threadId;

    // Top frame.
    let frame: DapStackFrame | undefined;
    try {
        const resp = await session.customRequest('stackTrace', {
            threadId: threadId ?? 1, startFrame: 0, levels: 1,
        }) as { stackFrames?: DapStackFrame[] };
        frame = resp.stackFrames?.[0];
    } catch (err) {
        output.appendLine(`[disasm] stackTrace: ${formatErr(err)}`);
    }
    if (!frame?.instructionPointerReference || !frame.source?.path) return;
    currentSourcePath = frame.source.path;

    // Function bounds — prefer full-function disassembly over a fixed window.
    let memRef = frame.instructionPointerReference;
    let instrOffset = -24;
    let instrCount = 96;
    let fnName = '';

    try {
        const bounds = await session.customRequest('bs/functionBounds', {}) as FunctionBoundsResponse;
        if (!bounds.unavailable && bounds.startAddress && bounds.endAddress) {
            const start = BigInt(bounds.startAddress);
            const end   = BigInt(bounds.endAddress);
            const count = Number((end - start) / 4n) + 8; // arm64: 4 bytes/insn
            if (count > 0 && count < 4096) {
                memRef      = bounds.startAddress;
                instrOffset = 0;
                instrCount  = count;
            }
        }
    } catch { /* adapter too old or not supported; fall back to window */ }

    try {
        const fr = await session.customRequest('bs/currentFunctionName', {}) as { name?: string };
        fnName = fr.name ?? '';
    } catch { /* optional */ }

    // Disassemble.
    let rawInstructions: DapInstruction[] = [];
    try {
        const resp = await session.customRequest('disassemble', {
            memoryReference: memRef,
            instructionOffset: instrOffset,
            instructionCount: instrCount,
        }) as { instructions?: DapInstruction[] };
        rawInstructions = resp.instructions ?? [];
    } catch (err) {
        output.appendLine(`[disasm] disassemble: ${formatErr(err)}`);
        return;
    }

    // Normalise current PC.
    let currentPc = '';
    try { currentPc = normAddr(frame.instructionPointerReference); } catch { /* skip */ }

    // Propagate source line numbers from the first instruction of each block.
    const instructions = propagateLines(rawInstructions, currentPc);

    // Debug: show raw DWARF annotations and propagated srcLines so we can
    // spot-check the line-number alignment.  Remove once alignment is verified.
    const annotated = rawInstructions
        .filter(i => i.line != null)
        .map(i => `  addr ${normAddrSafe(i.address)}  DWARF→${i.line}`);
    const propagated = instructions
        .map(i => `  addr ${i.addr}  src=${i.srcLine}  ${i.text.split(/\s/)[0]}`);
    output.appendLine(`[disasm debug] DWARF annotations:\n${annotated.join('\n')}`);
    output.appendLine(`[disasm debug] propagated srcLines:\n${propagated.join('\n')}`);

    const msg: WebviewUpdate = { type: 'update', instructions, currentPc, fnName };
    void panel.webview.postMessage(msg);
}

// Each instruction that carries a source annotation starts a new block.
// Instructions between annotations inherit the last seen line number.
function propagateLines(raw: DapInstruction[], currentPc: string): WvInstruction[] {
    let lastLine = 0;
    return raw.map((ins) => {
        if (ins.line != null) lastLine = ins.line;
        let addr = ins.address;
        try { addr = normAddr(ins.address); } catch { /* keep raw */ }
        return { srcLine: lastLine, text: ins.instruction, addr };
    });
}

function normAddr(hex: string): string {
    return BigInt(hex).toString(16);
}

function normAddrSafe(hex: string): string {
    try { return normAddr(hex); } catch { return hex; }
}

function formatErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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

  /* Mnemonic + operands */
  .mnem { color: var(--vscode-debugTokenExpression-name, #9cdcfe); margin-right: 4px; }
  .ops  { color: var(--vscode-editor-foreground); }

  .empty {
    padding: 16px;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    font-style: italic;
  }
</style>
</head>
<body>
<div id="fn-name">—</div>
<div id="root"><p class="empty">Pause the debugger to see assembly.</p></div>
<script>
(function() {
  let cursorLine = 0;

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') {
      document.getElementById('fn-name').textContent = data.fnName || '(function)';
      render(data.instructions, data.currentPc);
      // Scroll to the PC row after a render.
      scrollToRow(document.querySelector('.current-pc'));
    } else if (data.type === 'cursor') {
      cursorLine = data.line;
      applyCursorLine();
      // Scroll to first matching row without jarring snap.
      scrollToRow(document.querySelector('.cursor-line'), 'center');
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

      root.appendChild(row);
    });

    // Re-apply cursor highlight after re-render.
    applyCursorLine();
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
})();
</script>
</body>
</html>`;
}
