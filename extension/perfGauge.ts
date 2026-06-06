// IPC efficiency gauge — pure formatting, no vscode deps (so it's unit-testable
// standalone). Frames measured IPC against the Apple Firestorm peak, but only in
// the run regime where the cycle denominator is trustworthy.
// See rec/cpu-efficiency-research.md.

// Apple Firestorm (M1 P-core) sustained peak IPC for regular integer work:
// 6 integer execution ports (port-pressure bound). Decode/rename is 8-wide but
// only eliminated MOV/NOP reach 8 — real code is gated by the 6 ports. Verified
// 3-0 in the research; the 8-wide-as-IPC-ceiling claim was refuted.
export const FIRESTORM_IPC_PEAK = 6.0;

// IPC's denominator (cycles) is trap-dominated until user work ≫ the per-trap
// floor (~few-thousand cycles residual after TrapFloor correction). Below this
// many retired instructions the cycle count — and thus IPC — is noise, so we
// don't gauge it against peak (the exact instruction count is the honest signal
// at that granularity).
export const RUN_REGIME_MIN_INST = 50_000;

export interface IpcInputs {
    ipc?: number | null;
    runCycles: number;
    runInstructions?: number | null;
}

export interface IpcGauge {
    short: string;   // status-bar form, e.g. "IPC 1.42/6 (24%)"
    detail: string;  // tooltip lines
    pct: number;     // IPC as a percentage of peak
}

/// IPC as an efficiency gauge against the ~6.0 P-core ceiling — but only in the
/// run regime (a `continue` across enough work that cycles are trustworthy).
/// Returns `undefined` for single-step / tiny windows where IPC is trap-noise.
export function ipcGauge(s: IpcInputs): IpcGauge | undefined {
    const ipc = s.ipc;
    if (!ipc || ipc <= 0 || s.runCycles <= 0) return undefined;
    const inst = s.runInstructions ?? 0;
    if (inst < RUN_REGIME_MIN_INST) return undefined; // cycles untrustworthy here

    const pct = Math.round((ipc / FIRESTORM_IPC_PEAK) * 100);
    const short = `IPC ${ipc.toFixed(2)}/${FIRESTORM_IPC_PEAK} (${pct}%)`;
    // We can't name the bottleneck without PMU events (root-gated on macOS), so
    // the hint points at the regime, not a confirmed cause.
    let verdict: string;
    if (ipc >= 4.8) verdict = 'near peak — well-pipelined';
    else if (ipc >= 2.4) verdict = 'moderate — some stalls';
    else verdict = 'low — likely memory-, dependency-, or mispredict-bound (hardware counters needed to pinpoint)';
    const detail =
        `  IPC:     ${ipc.toFixed(3)} of ~${FIRESTORM_IPC_PEAK} peak (${pct}% — ${verdict})\n` +
        `           peak assumes a P-core; E-core ceiling is lower\n`;
    return { short, detail, pct };
}
