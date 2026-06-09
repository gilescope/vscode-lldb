// Unit tests for the Source+ASM data-gathering, driven through the extension's
// `_disasmTest` hook (so the test stays within its rootDir — no direct source
// import) with a plain mock session. No live debug session needed.
//
// Regression anchor: a `disassemble` row missing its `instruction` field used to
// throw inside the build path, which (as an unhandled async rejection) left the
// ASM panel stuck on "Pause the debugger to see assembly." even while paused.
// buildUpdate must return an update (or an explicit skip), never throw.
import * as assert from 'assert';
import * as vscode from 'vscode';

interface SessionLike { customRequest(command: string, args?: unknown): Promise<unknown>; }
interface WvInstruction { text: string; srcLine: number; notes?: { severity: string; text: string }[] }
interface BuildResult {
    update?: { instructions: WvInstruction[]; fnName: string; pressure: { nInstr: number }; efficiency?: unknown };
    skip?: string;
}
interface DisasmTestApi {
    buildUpdate(session: SessionLike, threadId: number | undefined, perf?: unknown): Promise<BuildResult>;
    propagateLines(raw: { address: string; instruction?: string; line?: number }[]): WvInstruction[];
    webviewHtml(): string;
}

type Responses = Record<string, unknown>;

function mockSession(overrides: Responses = {}): SessionLike {
    const responses: Responses = {
        stackTrace: { stackFrames: [{ instructionPointerReference: '0x1000', source: { path: '/x.rs' }, line: 5 }] },
        'bs/functionBounds': { startAddress: '0x1000', endAddress: '0x1010' },
        'bs/currentFunctionName': { name: 'foo' },
        disassemble: { instructions: [
            { address: '0x1000', instruction: 'add x0, x1, x2', line: 5 },
            { address: '0x1004', instruction: 'sdiv x0, x1, x2' },
            { address: '0x1008', instruction: 'ret' },
        ] },
        'bs/registers': { registers: { x0: '0x0', x1: '0x5', x2: '0x7' } },
        ...overrides,
    };
    return {
        customRequest(command: string) {
            const v = responses[command];
            return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
        },
    };
}

describe('disasm data-gathering', () => {
    let api: DisasmTestApi;

    before(async () => {
        const ext = vscode.extensions.getExtension('vadimcn.vscode-lldb');
        assert.ok(ext, 'extension vadimcn.vscode-lldb not found');
        const activated = (await ext!.activate()) as { _disasmTest?: DisasmTestApi };
        assert.ok(activated && activated._disasmTest, 'activate() did not return _disasmTest');
        api = activated._disasmTest;
    });

    it('builds an update for a valid stop', async () => {
        const res = await api.buildUpdate(mockSession(), 1);
        assert.ok(res.update, 'expected an update');
        assert.strictEqual(res.update!.instructions.length, 3);
        assert.strictEqual(res.update!.fnName, 'foo');
        assert.strictEqual(res.update!.pressure.nInstr, 3);
        assert.ok((res.update!.instructions[1].notes?.length ?? 0) > 0, 'sdiv should be flagged');
    });

    it('does not throw or blank when an instruction row lacks `instruction`', async () => {
        const res = await api.buildUpdate(mockSession({
            disassemble: { instructions: [
                { address: '0x1000', instruction: 'add x0, x1, x2', line: 5 },
                { address: '0x1004' },                       // no `instruction`
                { address: '0x1008', instruction: 'ret' },
            ] },
        }), 1);
        assert.ok(res.update, 'must still produce an update, not blank');
        assert.strictEqual(res.update!.instructions.length, 3);
        assert.strictEqual(res.update!.instructions[1].text, '', 'missing text guarded to empty');
    });

    it('skips with a reason when the top frame has no source path', async () => {
        const res = await api.buildUpdate(mockSession({
            stackTrace: { stackFrames: [{ instructionPointerReference: '0x1000' }] },
        }), 1);
        assert.ok(res.skip && /source path/.test(res.skip), `got ${JSON.stringify(res)}`);
    });

    it('skips when not stopped (no frames)', async () => {
        const res = await api.buildUpdate(mockSession({ stackTrace: { stackFrames: [] } }), 1);
        assert.ok(res.skip && /not stopped/.test(res.skip), `got ${JSON.stringify(res)}`);
    });

    it('skips (not throws) when stackTrace errors', async () => {
        const res = await api.buildUpdate(mockSession({ stackTrace: new Error('boom') }), 1);
        assert.ok(res.skip && /stackTrace failed/.test(res.skip), `got ${JSON.stringify(res)}`);
    });

    it('skips when disassembly is empty', async () => {
        const res = await api.buildUpdate(mockSession({ disassemble: { instructions: [] } }), 1);
        assert.ok(res.skip && /no instructions/.test(res.skip), `got ${JSON.stringify(res)}`);
    });

    it('adds a measured-vs-floor verdict in the run regime', async () => {
        const res = await api.buildUpdate(mockSession(), 1, { runCycles: 2_000_000, runInstructions: 1_000_000 });
        assert.ok(res.update && res.update.efficiency, 'run-regime perf → efficiency verdict');
    });

    it('omits the verdict for tiny windows (cycles untrustworthy)', async () => {
        const res = await api.buildUpdate(mockSession(), 1, { runCycles: 5000, runInstructions: 9 });
        assert.ok(res.update && !res.update.efficiency, 'single-step → no verdict');
    });

    it('propagateLines guards a missing instruction field to empty text', () => {
        const rows = api.propagateLines([
            { address: '0x1000', instruction: 'add x0, x1, x2', line: 5 },
            { address: '0x1004' },
        ]);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[1].text, '');
        assert.strictEqual(rows[1].srcLine, 5, 'inherits the last source line');
    });

    // Regression: the inlined webview JS lives inside an HTML *template literal*,
    // so a `\n` in the source becomes a real newline — which, inside a JS string
    // literal, is an unterminated-string SYNTAX ERROR. That kills the whole
    // script: no message listener registers, postMessage reports delivered=true,
    // and the panel stays blank with no error anywhere. Parse it to catch any
    // such breakage (Tier 3's `title += '\n\n…'` was exactly this).
    it('the inlined webview script parses (no syntax errors)', () => {
        const html = api.webviewHtml();
        const m = html.match(/<script>([\s\S]*?)<\/script>/);
        assert.ok(m, 'webview HTML must contain a <script> block');
        // new Function throws on a syntax error without executing the body.
        assert.doesNotThrow(() => { new Function(m![1]); }, 'webview script has a syntax error');
    });
});
