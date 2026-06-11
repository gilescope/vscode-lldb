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
    tbz: 'Branch if a bit is zero — the `#N` operand is the bit index in the register (e.g. `tbz w8, #0` tests bit 0).',
    tbnz: 'Branch if a bit is non-zero — the `#N` operand is the bit index in the register (e.g. `tbnz w8, #0` tests bit 0).',
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
export function baseMnemonic(mnemonic: string): string {
    let m = mnemonic.toLowerCase();
    // Conditional branch b.<cond> → describe as a conditional branch.
    if (m.startsWith('b.')) return 'b.cond';
    // Strip a trailing vector arrangement like ".4s" / ".16b" (e.g. add.4s).
    const dot = m.indexOf('.');
    if (dot > 0) m = m.slice(0, dot);
    return m;
}

// ── Plain-English instruction decode ─────────────────────────────────────────
// A concrete "what this line does" using the actual operands, so a reader who
// doesn't know AArch64 can follow it. Key clarity: a `#N` operand is an
// IMMEDIATE — a constant value, not a register.

// Binary ALU ops of the form `op Rd, Rn, Op2` → `Rd = Rn <sym> Op2`.
const BINOP: Readonly<Record<string, string>> = {
    add: '+', adds: '+', sub: '−', subs: '−', mul: '×',
    and: 'AND', ands: 'AND', orr: 'OR', eor: 'XOR', bic: 'AND NOT',
    lsl: '<<', lsr: '>> (unsigned)', asr: '>> (signed)', ror: 'rotate-right by',
    udiv: '÷ (unsigned)', sdiv: '÷ (signed)',
};

// Render an operand for the decode: a `#imm` becomes its bare number (so it
// reads as the constant it is), registers/memory pass through unchanged.
function decodeOperand(op: string): string {
    const m = op.match(/^#(-?(?:0x[0-9a-fA-F]+|\d+))$/);
    return m ? m[1] : op;
}

// Render an AArch64 memory addressing operand's *inside* (`sp, #0x28`,
// `x1, x2, lsl #2`, `x0`) as an arithmetic address (`sp + 0x28`).
function formatAddr(inside: string): string {
    const parts = inside.split(',').map((s) => s.trim());
    const base = parts[0];
    if (parts.length < 2) return base;
    const off = parts[1];
    const im = off.match(/^#(-?)(0x[0-9a-fA-F]+|\d+)$/);
    if (im) {
        return base + (im[1] === '-' ? ' − ' : ' + ') + im[2];
    }
    const shift = parts[2]?.match(/(lsl|lsr|asr)\s+#(\d+)/i);
    if (shift) return `${base} + (${off} << ${shift[2]})`;
    return `${base} + ${off}`;
}

// Size/sign note for sub-word load/store variants.
function memSizeNote(mnem: string): string {
    switch (mnem) {
        case 'ldrb': case 'strb': return ' (byte)';
        case 'ldrh': case 'strh': return ' (halfword)';
        case 'ldrsb': return ' (signed byte)';
        case 'ldrsh': return ' (signed halfword)';
        case 'ldrsw': return ' (signed word)';
        default: return '';
    }
}

// Decode a load/store into `dst = [addr]` / `[addr] = src`, including pre-index
// (`[sp, #-16]!`) and post-index (`[sp], #16`) writeback, and ld/st pairs.
// Returns undefined for non-memory mnemonics.
function decodeMemory(mnem: string, rest: string): string | undefined {
    const isLoad = mnem.startsWith('ld');
    const isStore = mnem.startsWith('st');
    if (!isLoad && !isStore) return undefined;
    const br = rest.indexOf('[');
    const end = rest.indexOf(']', br);
    if (br < 0 || end < 0) return undefined;

    const regs = rest.slice(0, br).split(',').map((s) => s.trim()).filter(Boolean);
    if (regs.length === 0) return undefined;
    const inside = rest.slice(br + 1, end).trim();
    const base = inside.split(',')[0].trim();
    const after = rest.slice(end + 1).trim();
    const preIndex = after.startsWith('!');
    const postImm = after.match(/^,\s*#(-?)(0x[0-9a-fA-F]+|\d+)/);

    const size = memSizeNote(mnem);
    const isPair = regs.length === 2;
    // Pre-index updates the base to (base+offset) *before* the access, so the
    // access is then through the bare base; post-index accesses [base] first.
    const addr = preIndex || postImm ? base : formatAddr(inside);

    const access = (i: number, plus = 0): string => {
        const at = plus ? `[${addr} + ${plus}]` : `[${addr}]`;
        return isLoad ? `${regs[i]} = ${at}${size}` : `${at} = ${regs[i]}${size}`;
    };
    let body = isPair ? `${access(0)}; ${access(1, 8)}` : access(0);

    if (preIndex) {
        // e.g. stp …, [sp, #-16]!  →  sp = sp − 16; [sp] = …   (a stack push)
        body = `${base} = ${formatAddr(inside)}; ${body}`;
    } else if (postImm) {
        // e.g. ldp …, [sp], #16  →  … = [sp]; sp = sp + 16   (a stack pop)
        const sign = postImm[1] === '-' ? ' − ' : ' + ';
        body = `${body}; ${base} = ${base}${sign}${postImm[2]}`;
    }
    return body;
}

/**
 * One-line plain-English decode for common instruction forms, or undefined for
 * forms we don't model (the mnemonic description still shows). Uses the real
 * operands: `subs w8, w8, #1` → "w8 = w8 − 1, and update the condition flags".
 */
export function explainInstruction(text: string): string | undefined {
    const sp = text.search(/\s/);
    if (sp < 0) return undefined;
    const mnem = baseMnemonic(text.slice(0, sp));
    const rest = text.slice(sp + 1);

    // Loads/stores: decode the addressing mode into `dst = [addr]` / `[addr] = src`.
    const mem = decodeMemory(mnem, rest);
    if (mem) return mem;

    const ops = rest.split(',').map((s) => s.trim()).filter(Boolean);
    // `s`-suffixed ALU ops also set the N/Z/C/V condition flags.
    const setsFlags = (mnem === 'adds' || mnem === 'subs' || mnem === 'ands')
        ? ', and update the condition flags' : '';

    if (BINOP[mnem] && ops.length >= 3 && !ops[1].includes('[')) {
        return `${ops[0]} = ${ops[1]} ${BINOP[mnem]} ${decodeOperand(ops[2])}${setsFlags}`;
    }
    if ((mnem === 'mov' || mnem === 'movz') && ops.length === 2) {
        return `${ops[0]} = ${decodeOperand(ops[1])}`;
    }
    if (mnem === 'mvn' && ops.length === 2) return `${ops[0]} = NOT ${decodeOperand(ops[1])}`;
    if (mnem === 'neg' && ops.length === 2) return `${ops[0]} = −${decodeOperand(ops[1])}`;
    if (mnem === 'cmp' && ops.length === 2) {
        return `compare ${ops[0]} with ${decodeOperand(ops[1])} (computes ${ops[0]} − ${decodeOperand(ops[1])} and keeps only the flags)`;
    }
    if (mnem === 'cmn' && ops.length === 2) {
        return `compare ${ops[0]} with −${decodeOperand(ops[1])}`;
    }
    return undefined;
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
const REG_TOKEN = /\b(x(?:[12]?\d|30)|w(?:[12]?\d|30)|sp|xzr|wzr)\b/gi;

/** An operand register: `name` exactly as written (`w8`, `x8`, `sp`), and `reg`,
 *  the 64-bit name it keys into the bs/registers map by (`w8`→`x8`). `width` is
 *  32 for a `w` view, else 64 — a `w` register is the low 32 bits of its `x`. */
export interface OperandReg {
    name: string;
    reg: string;
    width: 32 | 64;
}

/** Distinct registers referenced by an operand string, in source order,
 *  preserving the as-written form (so a `w8` operand shows as `w8`, not `x8`). */
export function operandRegisters(text: string): OperandReg[] {
    const ops = text.slice(text.search(/\s/) + 1); // drop the mnemonic
    const seen = new Set<string>();
    const out: OperandReg[] = [];
    for (const match of ops.matchAll(REG_TOKEN)) {
        const name = match[1].toLowerCase();
        if (name === 'xzr' || name === 'wzr') continue; // always zero, not interesting
        if (seen.has(name)) continue;
        seen.add(name);
        if (name.startsWith('w')) {
            out.push({ name, reg: 'x' + name.slice(1), width: 32 });
        } else {
            out.push({ name, reg: name, width: 64 });
        }
    }
    return out;
}

// ── Tooltip assembly ─────────────────────────────────────────────────────────

export interface AsmTooltip {
    mnemonic: string;
    description?: string;          // undefined for unknown mnemonics
    /** Live operand values, when the debugger supplied registers (current PC).
     *  `name` is as-written (`w8`); `value` is the value of that view (32-bit
     *  masked for a `w` register). */
    operands: Array<{ name: string; value: string }>;
}

/** Low 32 bits of a 64-bit `0x…` value string, as a `0x…` string. */
export function low32(hexValue: string): string {
    try {
        return '0x' + (BigInt(hexValue) & 0xffffffffn).toString(16);
    } catch {
        return hexValue;
    }
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
        for (const op of operandRegisters(text)) {
            const full = regs[op.reg];
            if (full === undefined) continue;
            operands.push({ name: op.name, value: op.width === 32 ? low32(full) : full });
        }
    }
    return { mnemonic, description: describeMnemonic(mnemonic), operands };
}
