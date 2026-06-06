// Human-readable explanations for disassembled instructions in the
// Source+ASM view's hover tooltip. Two parts:
//
//   describeMnemonic(mnemonic) → what the opcode family does (static, arm64)
//   describeInstruction(text, regs?) → a full plain-English line, optionally
//       substituting live register values when the debugger supplied them.
//
// arm64-focused (Apple Silicon is the primary target). Unknown mnemonics fall
// back to the raw text so the tooltip never lies — it just says less.

// ── Mnemonic dictionary ──────────────────────────────────────────────────────
// Keyed by the base mnemonic with size/condition suffixes stripped (see
// baseMnemonic). Kept terse: one line on what the instruction *does*, written
// for someone reading their own compiled code, not an ISA reference.
const ARM64_MNEMONICS: Readonly<Record<string, string>> = {
    // Moves / materialising constants
    mov: 'Copy a value between registers (or load a small immediate).',
    movz: 'Set a register to a 16-bit immediate, zeroing the rest.',
    movk: 'Overwrite one 16-bit chunk of a register, keeping the others — how big constants are built up.',
    movn: 'Set a register to the bitwise-NOT of a 16-bit immediate.',
    mvn: 'Bitwise-NOT of a register into another.',
    adr: 'Compute a PC-relative address into a register.',
    adrp: 'Compute a PC-relative page address (top bits of an address); usually paired with an add for the low bits.',

    // Integer arithmetic
    add: 'Add two values.',
    adds: 'Add and set the condition flags (N/Z/C/V).',
    sub: 'Subtract.',
    subs: 'Subtract and set the condition flags — this is what a comparison lowers to.',
    cmp: 'Compare two values (subtract, set flags, discard the result).',
    cmn: 'Compare-negative (add, set flags, discard the result).',
    neg: 'Negate (two’s complement).',
    mul: 'Multiply.',
    madd: 'Multiply two values and add a third (fused).',
    msub: 'Multiply two values and subtract from a third (fused).',
    mneg: 'Multiply and negate.',
    smull: 'Signed 32×32→64-bit multiply.',
    umull: 'Unsigned 32×32→64-bit multiply.',
    smulh: 'High 64 bits of a signed 64×64 multiply.',
    umulh: 'High 64 bits of an unsigned 64×64 multiply.',
    sdiv: 'Signed divide — expensive (tens of cycles); a hot one is worth avoiding.',
    udiv: 'Unsigned divide — expensive (tens of cycles); a hot one is worth avoiding.',

    // Bitwise / shifts
    and: 'Bitwise AND.',
    ands: 'Bitwise AND, setting the condition flags.',
    orr: 'Bitwise OR.',
    eor: 'Bitwise XOR.',
    bic: 'Bitwise AND with the complement (clear bits).',
    lsl: 'Logical shift left (multiply by a power of two).',
    lsr: 'Logical shift right (unsigned divide by a power of two).',
    asr: 'Arithmetic shift right (signed divide by a power of two).',
    ror: 'Rotate right.',
    sbfm: 'Signed bitfield move (sign-extend / extract a field).',
    ubfm: 'Unsigned bitfield move (zero-extend / extract a field).',
    sbfx: 'Signed bitfield extract.',
    ubfx: 'Unsigned bitfield extract.',
    bfi: 'Insert a bitfield into a register.',
    sxtw: 'Sign-extend a 32-bit value to 64 bits.',
    uxtw: 'Zero-extend a 32-bit value to 64 bits.',
    sxtb: 'Sign-extend a byte.',
    sxth: 'Sign-extend a halfword.',
    clz: 'Count leading zero bits.',
    rbit: 'Reverse the bit order.',
    rev: 'Reverse byte order (endianness swap).',

    // Loads / stores
    ldr: 'Load a value from memory into a register.',
    ldrb: 'Load a byte from memory (zero-extended).',
    ldrh: 'Load a halfword from memory (zero-extended).',
    ldrsw: 'Load a 32-bit value and sign-extend to 64 bits.',
    ldrsb: 'Load a byte and sign-extend.',
    ldrsh: 'Load a halfword and sign-extend.',
    ldur: 'Load from memory with an unscaled offset.',
    ldp: 'Load a pair of registers from consecutive memory — common in function prologues restoring saved regs.',
    str: 'Store a register to memory.',
    strb: 'Store a byte to memory.',
    strh: 'Store a halfword to memory.',
    stur: 'Store to memory with an unscaled offset.',
    stp: 'Store a pair of registers to consecutive memory — common in prologues saving regs / setting up a frame.',
    ldxr: 'Load-exclusive (start of an atomic read-modify-write).',
    stxr: 'Store-exclusive (end of an atomic read-modify-write; reports whether it succeeded).',
    ldar: 'Load-acquire (atomic load with ordering).',
    stlr: 'Store-release (atomic store with ordering).',
    cas: 'Atomic compare-and-swap.',

    // Branches / control flow
    b: 'Unconditional branch (jump).',
    br: 'Branch to an address in a register (indirect jump).',
    bl: 'Branch with link — a function CALL (saves the return address in x30).',
    blr: 'Indirect call through a register (saves return in x30) — e.g. a vtable / fn-pointer call.',
    ret: 'Return from a function (jump to the address in x30).',
    cbz: 'Branch if a register is zero.',
    cbnz: 'Branch if a register is non-zero.',
    tbz: 'Branch if a specific bit is zero.',
    tbnz: 'Branch if a specific bit is non-zero.',
    csel: 'Conditional select — pick one of two registers based on the flags (a branchless if).',
    cset: 'Set a register to 1 or 0 based on a condition (branchless boolean).',
    csinc: 'Conditional select-increment.',
    ccmp: 'Conditional compare — chains comparisons without branching.',

    // System / misc
    nop: 'Do nothing (padding / alignment).',
    svc: 'Supervisor call — enter the kernel (a syscall).',
    brk: 'Breakpoint trap.',
    dmb: 'Data memory barrier (orders memory accesses).',
    dsb: 'Data synchronization barrier.',
    isb: 'Instruction synchronization barrier.',
    mrs: 'Read a system register.',
    msr: 'Write a system register.',

    // Floating-point / SIMD (NEON) — presence of these on a hot line is the
    // good case; their ABSENCE on a numeric loop is the "missing a trick".
    fmov: 'Move a floating-point value (or bit-pattern) between registers.',
    fadd: 'Floating-point add.',
    fsub: 'Floating-point subtract.',
    fmul: 'Floating-point multiply.',
    fdiv: 'Floating-point divide — expensive.',
    fmadd: 'Fused multiply-add (floating-point).',
    fsqrt: 'Floating-point square root — expensive.',
    fcmp: 'Floating-point compare.',
    fcvt: 'Convert between floating-point formats.',
    scvtf: 'Convert a signed integer to floating-point.',
    ucvtf: 'Convert an unsigned integer to floating-point.',
    fcvtzs: 'Convert floating-point to a signed integer (toward zero).',
    dup: 'Duplicate a value across all lanes of a SIMD vector.',
    addv: 'Sum all lanes of a SIMD vector (horizontal add).',
    ld1: 'SIMD: load multiple lanes from memory (vectorised load).',
    st1: 'SIMD: store multiple lanes to memory (vectorised store).',
};

// Suffixes that don't change the *meaning* worth describing (size, vector
// arrangement, set-flags variants we don't have a distinct entry for).
function baseMnemonic(mnemonic: string): string {
    let m = mnemonic.toLowerCase();
    // Conditional branch b.<cond> → describe as a conditional branch.
    if (m.startsWith('b.')) return 'b.cond';
    // Strip a trailing vector arrangement like ".4s" / ".16b" (e.g. add.4s).
    const dot = m.indexOf('.');
    if (dot > 0) m = m.slice(0, dot);
    return m;
}

/** Plain-English description for a mnemonic, or undefined if unknown. */
export function describeMnemonic(mnemonic: string): string | undefined {
    const m = baseMnemonic(mnemonic);
    if (m === 'b.cond') {
        return 'Conditional branch — jump only if the flags match the condition.';
    }
    return ARM64_MNEMONICS[m];
}

// ── Operand register extraction ──────────────────────────────────────────────

// Match arm64 GPR operands: x0–x30, w0–w30, sp, plus the zero registers.
// Returned in source order, de-duplicated, normalised to the 64-bit name so
// they key into the bs/registers map (w3 → x3, wzr/xzr dropped).
const REG_TOKEN = /\b(x(?:[12]?\d|30)|w(?:[12]?\d|30)|sp|xzr|wzr)\b/gi;

/** Distinct 64-bit register names referenced by an operand string, in order. */
export function operandRegisters(text: string): string[] {
    const ops = text.slice(text.search(/\s/) + 1); // drop the mnemonic
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of ops.matchAll(REG_TOKEN)) {
        let r = match[1].toLowerCase();
        if (r === 'xzr' || r === 'wzr') continue; // always zero, not interesting
        if (r.startsWith('w')) r = 'x' + r.slice(1); // w3 and x3 share the map key
        if (!seen.has(r)) { seen.add(r); out.push(r); }
    }
    return out;
}

// ── Tooltip assembly ─────────────────────────────────────────────────────────

export interface AsmTooltip {
    mnemonic: string;
    description?: string;          // undefined for unknown mnemonics
    /** Live operand values, when the debugger supplied registers (current PC). */
    operands: Array<{ reg: string; value: string }>;
}

/**
 * Build the tooltip payload for one instruction. `regs` is the bs/registers
 * map (`{ x0: "0x…", … }`); pass it only for the current-PC row, where the
 * values are actually live. Other rows get the static description alone.
 */
export function describeInstruction(
    text: string,
    regs?: Readonly<Record<string, string>>,
): AsmTooltip {
    const sp = text.search(/\s/);
    const mnemonic = sp >= 0 ? text.slice(0, sp) : text;
    const operands: AsmTooltip['operands'] = [];
    if (regs) {
        for (const reg of operandRegisters(text)) {
            const value = regs[reg];
            if (value !== undefined) operands.push({ reg, value });
        }
    }
    return { mnemonic, description: describeMnemonic(mnemonic), operands };
}
