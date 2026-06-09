// Data-gathering for the Source+ASM view, factored out of the VS Code glue so
// it's unit-testable with a mock session (no vscode imports here). Given a
// session-like object it queries the adapter (stackTrace / functionBounds /
// disassemble / registers / perf) and builds the WebviewUpdate the panel
// renders — or returns an explicit `skip` reason so a blank panel is always
// diagnosable instead of failing silently.

import { describeMnemonic, operandRegisters, type OperandReg } from './asmDescribe';
import {
    lineNotes, portPressure, measuredEfficiency,
    type EfficiencyNote, type PortPressure, type MeasuredEfficiency,
} from './asmModel';
import { RUN_REGIME_MIN_INST } from './perfGauge';

// ── DAP wire types ───────────────────────────────────────────────────────────

export interface DapInstruction {
    address: string;
    instruction: string;
    location?: { path?: string };
    line?: number;
}

export interface DapStackFrame {
    source?: { path?: string };
    line?: number;
    instructionPointerReference?: string;
}

export interface FunctionBoundsResponse {
    startAddress?: string;
    endAddress?: string;
    unavailable?: boolean;
}

// The bits of the perf `stopped`-event body the ASM view consumes.
export interface BsPerf {
    runCycles?: number;
    runInstructions?: number | null;
}

// ── Webview wire types ───────────────────────────────────────────────────────

export interface WvInstruction {
    srcLine: number;    // 1-based; 0 = no source info
    text: string;       // mnemonic + operands (no address)
    addr: string;       // normalised hex, for PC comparison
    desc?: string;      // plain-English description of the mnemonic (static)
    regs?: OperandReg[]; // operand registers (as-written name + 64-bit key + width)
    notes?: EfficiencyNote[]; // per-line efficiency flags (expensive ops)
}

export interface WebviewUpdate {
    type: 'update';
    instructions: WvInstruction[];
    currentPc: string;
    fnName: string;
    registers: Record<string, string>;
    pressure: PortPressure;
    efficiency?: MeasuredEfficiency;
}

/** Minimal session surface — just the DAP custom-request channel. */
export interface SessionLike {
    customRequest(command: string, args?: unknown): Thenable<unknown> | Promise<unknown>;
}

/** Result of a build attempt: an update to post, or a reason it was skipped. */
export type BuildResult =
    | { update: WebviewUpdate }
    | { skip: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

export function normAddr(hex: string): string {
    return BigInt(hex).toString(16);
}

function normAddrSafe(hex: string): string {
    try { return normAddr(hex); } catch { return hex; }
}

// Each instruction that carries a source annotation starts a new block;
// instructions between annotations inherit the last seen line number. Also
// attaches the static description / operand registers / efficiency notes so the
// webview needs no per-hover round-trip. Defensive against a missing
// `instruction` field (some adapters/edge rows) — an empty string, never a throw.
export function propagateLines(raw: DapInstruction[]): WvInstruction[] {
    let lastLine = 0;
    return raw.map((ins) => {
        if (ins.line != null) lastLine = ins.line;
        const addr = normAddrSafe(ins.address ?? '');
        const text = ins.instruction ?? '';
        const sp = text.search(/\s/);
        const mnemonic = sp >= 0 ? text.slice(0, sp) : text;
        return {
            srcLine: lastLine,
            text,
            addr,
            desc: describeMnemonic(mnemonic),
            regs: operandRegisters(text),
            notes: lineNotes(text),
        };
    });
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Query the adapter and build the panel update for the current stop. Returns
 * `{ skip }` (never throws) when there's nothing renderable yet — e.g. the
 * session isn't stopped, the top frame has no PC/source, or disassembly is
 * empty. The caller logs the reason so a blank panel can be explained.
 */
export async function buildDisasmUpdate(
    session: SessionLike,
    threadId: number | undefined,
    perf?: BsPerf,
): Promise<BuildResult> {
    // Top frame.
    let frame: DapStackFrame | undefined;
    try {
        const resp = await session.customRequest('stackTrace', {
            threadId: threadId ?? 1, startFrame: 0, levels: 1,
        }) as { stackFrames?: DapStackFrame[] };
        frame = resp.stackFrames?.[0];
    } catch (err) {
        return { skip: `stackTrace failed: ${errMsg(err)}` };
    }
    if (!frame) return { skip: 'no stack frame (not stopped?)' };
    if (!frame.instructionPointerReference) return { skip: 'top frame has no instructionPointerReference' };
    if (!frame.source?.path) return { skip: 'top frame has no source path' };

    // Function bounds — prefer full-function disassembly over a fixed window.
    let memRef = frame.instructionPointerReference;
    let instrOffset = -24;
    let instrCount = 96;
    try {
        const bounds = await session.customRequest('bs/functionBounds', {}) as FunctionBoundsResponse;
        if (bounds && !bounds.unavailable && bounds.startAddress && bounds.endAddress) {
            const count = Number((BigInt(bounds.endAddress) - BigInt(bounds.startAddress)) / 4n) + 8;
            if (count > 0 && count < 4096) {
                memRef = bounds.startAddress;
                instrOffset = 0;
                instrCount = count;
            }
        }
    } catch { /* adapter too old / unsupported; fall back to the window */ }

    let fnName = '';
    try {
        const fr = await session.customRequest('bs/currentFunctionName', {}) as { name?: string };
        fnName = fr?.name ?? '';
    } catch { /* optional */ }

    // Disassemble.
    let rawInstructions: DapInstruction[] = [];
    try {
        const resp = await session.customRequest('disassemble', {
            memoryReference: memRef, instructionOffset: instrOffset, instructionCount: instrCount,
        }) as { instructions?: DapInstruction[] };
        rawInstructions = resp?.instructions ?? [];
    } catch (err) {
        return { skip: `disassemble failed: ${errMsg(err)}` };
    }
    if (rawInstructions.length === 0) return { skip: 'disassemble returned no instructions' };

    const currentPc = normAddrSafe(frame.instructionPointerReference);

    let registers: Record<string, string> = {};
    try {
        const rr = await session.customRequest('bs/registers', {}) as { registers?: Record<string, string> };
        registers = rr?.registers ?? {};
    } catch { /* optional — older adapter; tooltip shows the description only */ }

    const instructions = propagateLines(rawInstructions);
    const pressure = portPressure(instructions.map((i) => i.text));

    // Tier 3: measured-vs-floor, run regime only (cycles trustworthy).
    let efficiency: MeasuredEfficiency | undefined;
    const runInst = perf?.runInstructions ?? 0;
    if (perf && perf.runCycles && perf.runCycles > 0 && runInst >= RUN_REGIME_MIN_INST) {
        efficiency = measuredEfficiency(pressure, runInst, perf.runCycles);
    }

    return {
        update: {
            type: 'update', instructions, currentPc, fnName, registers, pressure, efficiency,
        },
    };
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
