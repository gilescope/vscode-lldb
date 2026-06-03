// End-to-end test of the per-step-cost HoverProvider, run inside a real
// VS Code via @vscode/test-electron. We inject a step cost through the
// extension's test hook (no live debug session needed) and read the hover
// back with `vscode.executeHoverProvider` — the API path that a decoration
// hoverMessage could never be tested through.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

interface PerfTestApi {
    setStepCost(
        fsPath: string,
        line: number,
        inst: number,
        hits?: number,
        extra?: { cycles?: number; ipc?: number | null; diagnosis?: { emoji: string; label: string; summary: string; hint: string } | null; memDelta?: number | null },
    ): void;
    setFocus(fsPath: string, line: number): void;
    paneRows(): string[];
    clear(): void;
}

function hoverText(hovers: vscode.Hover[] | undefined): string {
    return (hovers ?? [])
        .flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value)))
        .join('\n');
}

describe('per-step cost hover', () => {
    let tmpFile: string;
    let uri: vscode.Uri;
    let perf: PerfTestApi;

    before(async () => {
        tmpFile = path.join(os.tmpdir(), `bs-perf-hover-${process.pid}.rs`);
        fs.writeFileSync(tmpFile, 'fn main() {\n    let acc = work();\n    println!("{acc}");\n}\n');
        uri = vscode.Uri.file(tmpFile);

        const ext = vscode.extensions.getExtension('vadimcn.vscode-lldb');
        assert.ok(ext, 'extension vadimcn.vscode-lldb not found');
        const api = (await ext!.activate()) as { _perfTest?: PerfTestApi };
        assert.ok(api && api._perfTest, 'activate() did not return _perfTest');
        perf = api._perfTest;

        // Open so the doc resolves to languageId 'rust' (selector match).
        await vscode.workspace.openTextDocument(uri);
    });

    after(() => {
        perf?.clear();
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    });

    it('returns the exact instruction count on a costed line', async () => {
        perf.clear();
        perf.setStepCost(uri.fsPath, 2, 3_777_494, 2); // 1-based line 2, stepped twice
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', uri, new vscode.Position(1, 4), // line index 1 == line 2
        );
        const text = hoverText(hovers);
        assert.ok(text.includes('BugStalker step cost'), `missing title; got: ${text}`);
        assert.ok(text.includes('3,777,494'), `missing exact count; got: ${text}`);
        assert.ok(text.includes('avg/step'), `missing avg for hits>1; got: ${text}`);
    });

    it('returns no perf hover on an un-costed line', async () => {
        perf.clear();
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', uri, new vscode.Position(2, 4),
        );
        assert.ok(!hoverText(hovers).includes('BugStalker step cost'), 'unexpected perf hover on un-costed line');
    });
});

describe('step costs pane (focus-line readout)', () => {
    let perf: PerfTestApi;
    const f = '/tmp/bs-pane-fixture.rs';

    before(async () => {
        const ext = vscode.extensions.getExtension('vadimcn.vscode-lldb');
        const api = (await ext!.activate()) as { _perfTest?: PerfTestApi };
        perf = api!._perfTest!;
    });
    after(() => perf?.clear());

    it('shows per-step metrics with categorisation (+ full detail) last', () => {
        perf.clear();
        perf.setStepCost(f, 26, 3_777_494, 1, {
            cycles: 5_000_000,
            ipc: 1.33,
            diagnosis: { emoji: '💤', label: 'mostly-waiting', summary: 'CPU active for 0% of wall time', hint: 'blocked on I/O, sleep, lock contention, or syscall' },
            memDelta: 1024 * 1024, // +1 MB
        });
        perf.setFocus(f, 26);
        const arr = perf.paneRows();
        const rows = arr.join('\n');
        assert.ok(/:26/.test(rows), `header line; rows:\n${rows}`);
        assert.ok(rows.includes('instructions | 3,777,494'), `instructions; rows:\n${rows}`);
        assert.ok(rows.includes('cycles | 5,000,000'), `cycles; rows:\n${rows}`);
        assert.ok(rows.includes('IPC | 1.33'), `IPC; rows:\n${rows}`);
        assert.ok(rows.includes('memory Δ | +1.0 MB'), `memory Δ; rows:\n${rows}`);
        // categorisation + full detail (summary + hint) present...
        assert.ok(rows.includes('mostly-waiting'), `categorisation; rows:\n${rows}`);
        assert.ok(rows.includes('CPU active for 0% of wall time'), `summary detail; rows:\n${rows}`);
        assert.ok(rows.includes('blocked on I/O'), `hint detail; rows:\n${rows}`);
        // ...and it's LAST (below memory Δ)
        const memIdx = arr.findIndex((r) => r.includes('memory Δ'));
        const catIdx = arr.findIndex((r) => r.includes('mostly-waiting'));
        assert.ok(memIdx >= 0 && catIdx > memIdx, `categorisation should sit below memory Δ; rows:\n${rows}`);
        assert.ok(!rows.includes('steps over line') && !rows.includes('avg/step'), `dropped rows present; rows:\n${rows}`);
    });

    it('shows — for PMU-only metrics on the rusage (macOS) path', () => {
        perf.clear();
        perf.setStepCost(f, 30, 90_000); // no cycles/ipc → unavailable
        perf.setFocus(f, 30);
        const rows = perf.paneRows().join('\n');
        assert.ok(rows.includes('instructions | 90,000'), `instructions; rows:\n${rows}`);
        assert.ok(rows.includes('cycles | —'), `cycles dash; rows:\n${rows}`);
        assert.ok(rows.includes('IPC | —'), `IPC dash; rows:\n${rows}`);
    });

    it('says so when the focused line has no recorded cost', () => {
        perf.clear();
        perf.setFocus(f, 99);
        const rows = perf.paneRows().join('\n');
        assert.ok(/no recorded cost/.test(rows), `expected no-cost note; rows:\n${rows}`);
    });

    it('prompts to step when nothing is focused', () => {
        perf.clear();
        const rows = perf.paneRows().join('\n');
        assert.ok(/Step to record/.test(rows), `expected step prompt; rows:\n${rows}`);
    });
});
