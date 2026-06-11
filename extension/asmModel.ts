// Static CPU-efficiency model for the Source+ASM view. Pure analysis of the
// executed disassembly — no PMU, no privilege, fully deterministic, works even
// on a single instruction (see rec/cpu-efficiency-research.md for why this is
// the only honest per-line efficiency signal on Apple Silicon).
//
// Two products:
//   lineNotes(text)        → per-line "missing a trick" flags (expensive ops)
//   portPressure(texts[])  → region throughput floor + bottleneck port + mix
//
// The port/throughput numbers model the Apple Firestorm P-core (M1; later P-cores
// are close) from Dougall Johnson's applecpu reverse-engineering. They are
// APPROXIMATE and throughput-only — the floor ignores dependency-chain latency,
// so it's an optimistic lower bound, useful for spotting the *bottleneck port*,
// not for cycle-accurate prediction. All constants live in GROUPS so they're
// trivially tunable per core generation.

import { baseMnemonic } from './asmDescribe';

// ── Execution-port groups (simplified Firestorm) ─────────────────────────────
// `throughput` = ops this group's ports can retire per cycle (aggregate).
// Infinity = eliminated at rename (effectively free).
export type PortGroup =
    | 'int' | 'mul' | 'div' | 'load' | 'store'
    | 'simd' | 'fdiv' | 'branch' | 'serializing' | 'eliminated' | 'other';

interface GroupInfo { throughput: number; label: string; }

// Sources: dougallj.github.io/applecpu (firestorm-int / -simd), ocxtal
// insn_bench_aarch64. Throughputs are per-cycle aggregate across the group's
// ports. Contested counts (load/store unit count) kept conservative.
export const GROUPS: Readonly<Record<PortGroup, GroupInfo>> = {
    int:         { throughput: 6,        label: 'integer ALU (6 ports)' },
    mul:         { throughput: 2,        label: 'integer multiply' },
    div:         { throughput: 0.5,      label: 'integer divide (1 port, 1/2cyc)' },
    load:        { throughput: 3,        label: 'load' },
    store:       { throughput: 2,        label: 'store' },
    simd:        { throughput: 4,        label: 'SIMD/FP (4 ports)' },
    fdiv:        { throughput: 0.25,     label: 'FP divide/sqrt (1 port)' },
    branch:      { throughput: 2,        label: 'branch' },
    serializing: { throughput: 0.5,      label: 'serializing/barrier' },
    eliminated:  { throughput: Infinity, label: 'eliminated at rename' },
    other:       { throughput: 1,        label: 'other' },
};

// ── Classification ───────────────────────────────────────────────────────────

const DIV = new Set(['sdiv', 'udiv']);
const FDIV = new Set(['fdiv', 'fsqrt', 'frsqrte', 'frsqrts', 'frecpe', 'frecps']);
const MUL = new Set(['mul', 'madd', 'msub', 'mneg', 'smull', 'umull', 'smulh', 'umulh', 'smaddl', 'umaddl']);
const BRANCH = new Set(['b', 'b.cond', 'br', 'bl', 'blr', 'ret', 'cbz', 'cbnz', 'tbz', 'tbnz', 'braa', 'blraa']);
const SERIALIZING = new Set(['dmb', 'dsb', 'isb', 'svc', 'brk', 'hvc', 'smc']);
// Scalar-FP / NEON data ops (loads/stores handled separately by prefix).
const SIMD = new Set([
    'fadd', 'fsub', 'fmul', 'fmadd', 'fmsub', 'fnmul', 'fabs', 'fneg', 'fcmp', 'fccmp',
    'fcvt', 'fcvtzs', 'fcvtzu', 'fcvtas', 'fcvtau', 'scvtf', 'ucvtf', 'fmov', 'fcsel',
    'fmax', 'fmin', 'fmaxnm', 'fminnm', 'frinta', 'frintn', 'frintm', 'frintp', 'frintz',
    'dup', 'addv', 'uaddlv', 'saddlv', 'cnt', 'tbl', 'zip1', 'zip2', 'uzp1', 'uzp2',
    'trn1', 'trn2', 'ext', 'ins', 'umov', 'smov', 'sshl', 'ushl', 'shl', 'sshr', 'ushr',
    'mla', 'mls', 'umlal', 'smlal', 'umull2', 'smull2', 'movi', 'mvni', 'bsl', 'bit', 'bif',
]);
const INT = new Set([
    'add', 'adds', 'sub', 'subs', 'cmp', 'cmn', 'neg', 'negs', 'adc', 'sbc',
    'and', 'ands', 'orr', 'orn', 'eor', 'eon', 'bic', 'bics', 'mvn', 'tst',
    'lsl', 'lsr', 'asr', 'ror', 'lslv', 'lsrv', 'asrv', 'rorv',
    'sbfm', 'ubfm', 'bfm', 'sbfx', 'ubfx', 'bfi', 'bfxil', 'sbfiz', 'ubfiz', 'extr',
    'sxtb', 'sxth', 'sxtw', 'uxtb', 'uxth', 'uxtw', 'clz', 'cls', 'rbit', 'rev', 'rev16', 'rev32',
    'movz', 'movk', 'movn', 'adr', 'adrp',
    'csel', 'csinc', 'csinv', 'csneg', 'cset', 'csetm', 'cinc', 'cinv', 'cneg', 'ccmp', 'ccmn',
]);

// A load/store if the mnemonic starts with these (covers all width/sign/atomic
// variants: ldr/ldrb/ldrsw/ldp/ldur/ldxr/ldar/ld1…, str/stp/stur/stxr/stlr/st1…).
function memKind(base: string): PortGroup | undefined {
    if (base.startsWith('ld')) return 'load';
    if (base.startsWith('st')) return 'store';
    if (base === 'prfm') return 'load'; // prefetch uses a load slot
    if (base === 'cas' || base === 'casa' || base === 'casal' || base.startsWith('swp')) return 'store';
    return undefined;
}

/** Does `text`'s operand list look like all-register (no immediate, no memory)? */
function allRegisterOperands(text: string): boolean {
    const ops = text.slice(text.search(/\s/) + 1);
    if (!ops || text.search(/\s/) < 0) return false;
    if (ops.includes('#') || ops.includes('[')) return false;
    return /\b[wx]\d|\b[wx]zr|\bsp\b/i.test(ops);
}

/** Map one instruction to its execution-port group. */
export function classify(text: string): PortGroup {
    const sp = text.search(/\s/);
    const mnemonic = sp >= 0 ? text.slice(0, sp) : text;
    const base = baseMnemonic(mnemonic);

    if (base === 'nop' || base === 'hint') return 'eliminated';
    // Register-to-register MOV is eliminated at rename; MOV of an immediate isn't.
    if (base === 'mov' && allRegisterOperands(text)) return 'eliminated';
    if (base === 'mov') return 'int';

    if (DIV.has(base)) return 'div';
    if (FDIV.has(base)) return 'fdiv';
    if (SERIALIZING.has(base)) return 'serializing';
    if (BRANCH.has(base)) return 'branch';
    if (MUL.has(base)) return 'mul';

    const mem = memKind(base);
    if (mem) return mem;

    if (INT.has(base)) return 'int';
    if (SIMD.has(base) || base.startsWith('f')) return 'simd';
    return 'other';
}

// ── Per-line efficiency notes ────────────────────────────────────────────────

export interface EfficiencyNote {
    severity: 'warn' | 'info';
    text: string;
}

// Per-line, honest, deterministic flags. We only warn on things a single
// instruction genuinely tells us — expensive functional units and pipeline
// serialization. Vectorization and register-spill are *region* patterns
// (see portPressure), not single-line facts, so they're not flagged here.
export function lineNotes(text: string): EfficiencyNote[] {
    const g = classify(text);
    switch (g) {
        case 'div':
            return [{ severity: 'warn', text: 'Integer divide — single execution port, ~1 per 2 cycles, ≥7-cycle latency. If hot, strength-reduce (shift / reciprocal-multiply).' }];
        case 'fdiv': {
            const base = baseMnemonic(text.split(/\s/)[0]);
            const what = base === 'fsqrt' ? 'square root' : 'divide';
            return [{ severity: 'warn', text: `FP ${what} — single port (V0), low throughput. If hot, consider a reciprocal/Newton step.` }];
        }
        case 'serializing': {
            const base = baseMnemonic(text.split(/\s/)[0]);
            if (base === 'svc') return [{ severity: 'info', text: 'Syscall — leaves user mode; cost is dominated by the kernel, not this instruction.' }];
            return [{ severity: 'warn', text: 'Memory barrier — serializes the pipeline (drains in-flight memory ops).' }];
        }
        default:
            return [];
    }
}

// ── Region port-pressure ─────────────────────────────────────────────────────

export interface PortPressure {
    nInstr: number;
    /** Throughput floor in cycles for the region (optimistic; latency-blind). */
    minCycles: number;
    /**
     * Best achievable IPC for *this instruction mix* = nInstr / minCycles,
     * capped at the core's integer-port peak. The key Tier-3 number: it's the
     * ceiling the *code* allows, not the core's all-ALU peak. Divide-heavy code
     * has a low mix peak no matter how well scheduled — so measured-IPC ÷ this
     * tells you whether the win is the algorithm (near the mix peak) or the
     * stalls (far below it). Static, deterministic.
     */
    peakIpc: number;
    /** The port group that sets the floor. */
    bottleneck: PortGroup;
    bottleneckLabel: string;
    /** Instruction count per group (only non-zero groups). */
    demand: Partial<Record<PortGroup, number>>;
    /** Fraction of data-ops that are SIMD/FP vs scalar-int (0..1), or null if none. */
    simdShare: number | null;
    /** Stack loads/stores (`[sp, #…]`) — a spill-pressure proxy. */
    stackTraffic: number;
}

const SP_MEM = /\[\s*sp\b/i;

/**
 * Throughput floor + bottleneck port for a straight-line region (e.g. the
 * disassembled function). The region can't retire faster than its busiest
 * port group: minCycles = max over groups of (count / group throughput).
 * Eliminated ops contribute zero. Latency/dependency chains are ignored, so
 * this is an optimistic floor — good for naming the bottleneck, not for exact
 * cycle counts.
 */
export function portPressure(texts: string[]): PortPressure {
    const demand: Partial<Record<PortGroup, number>> = {};
    let simd = 0, scalarData = 0, stackTraffic = 0;
    for (const text of texts) {
        if (!text) continue;
        const g = classify(text);
        demand[g] = (demand[g] ?? 0) + 1;
        if (g === 'simd' || g === 'fdiv') simd += 1;
        if (g === 'int' || g === 'mul' || g === 'div') scalarData += 1;
        if ((g === 'load' || g === 'store') && SP_MEM.test(text)) stackTraffic += 1;
    }

    let minCycles = 0;
    let bottleneck: PortGroup = 'int';
    for (const key of Object.keys(demand) as PortGroup[]) {
        const cycles = (demand[key] ?? 0) / GROUPS[key].throughput; // Infinity tput → 0
        if (cycles > minCycles) { minCycles = cycles; bottleneck = key; }
    }

    const dataOps = simd + scalarData;
    const nInstr = texts.filter(Boolean).length;
    // Core integer-port count is the absolute IPC ceiling (all-ALU peak); the
    // mix peak can't exceed it. minCycles==0 (all eliminated) ⇒ ceiling.
    const corePeak = GROUPS.int.throughput;
    const peakIpc = minCycles > 0 ? Math.min(corePeak, nInstr / minCycles) : corePeak;
    return {
        nInstr,
        minCycles,
        peakIpc,
        bottleneck,
        bottleneckLabel: GROUPS[bottleneck].label,
        demand,
        simdShare: dataOps > 0 ? simd / dataOps : null,
        stackTraffic,
    };
}

// ── Measured vs floor (Tier 3) ───────────────────────────────────────────────

export interface MeasuredEfficiency {
    /** measured CPI ÷ static floor CPI. ~1 = at the mix ceiling; higher = stalls. */
    ratio: number;
    /** Where the headroom is: change the code, or chase the stalls. */
    bound: 'algorithm' | 'mixed' | 'stalls';
    /** One-line verdict for display. */
    verdict: string;
}

/**
 * Combine the static throughput floor with run-regime measured counters into a
 * "how far above the floor are we" ratio and an algorithm-vs-stalls verdict.
 * Both inputs are per-instruction (CPI), so it's iteration-count-independent —
 * but it assumes the executed mix ≈ the displayed function's static mix, so it's
 * APPROXIMATE (the caller must already have gated on the run regime). Returns
 * `undefined` when the inputs can't form a ratio.
 */
export function measuredEfficiency(
    p: PortPressure,
    runInstructions: number,
    runCycles: number,
): MeasuredEfficiency | undefined {
    if (runInstructions <= 0 || runCycles <= 0 || p.minCycles <= 0 || p.nInstr <= 0) {
        return undefined;
    }
    const floorCpi = p.minCycles / p.nInstr;
    const measuredCpi = runCycles / runInstructions;
    // ratio < 1 means the executed hot path is cheaper than the whole displayed
    // function's static mix — treat as "at the ceiling" rather than report <1×.
    const ratio = Math.max(1, measuredCpi / floorCpi);

    if (ratio <= 1.3) {
        return {
            ratio,
            bound: 'algorithm',
            verdict: `at the throughput ceiling for this instruction mix — to go faster, do fewer ${p.bottleneckLabel} ops (algorithm), scheduling won't help`,
        };
    }
    if (ratio <= 2.5) {
        return { ratio, bound: 'mixed', verdict: 'some headroom below this mix’s ceiling — partial stalls' };
    }
    return {
        ratio,
        bound: 'stalls',
        verdict: 'well below this mix’s ceiling — stalls (memory / dependencies / mispredicts); hardware counters needed to pinpoint',
    };
}
