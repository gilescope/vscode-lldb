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
    setStepCost(fsPath: string, line: number, inst: number, hits?: number): void;
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
