// macOS entitlement self-heal for the BugStalker DAP adapter.
//
// On macOS, `bs` needs the `com.apple.security.cs.debugger`
// entitlement to call `task_for_pid` (without it, every breakpoint
// path silently fails). `cargo install` strips codesign signatures
// on every rebuild, so users who develop BugStalker hit this any
// time they `cargo install --path .`.
//
// BugStalker can't sign *itself* — by the time the running process
// notices the missing entitlement, its on-disk binary is already
// loaded into memory. The extension can: it runs as a separate
// Node process, resolves the `bs` path, and codesigns the binary
// *before* spawning the DAP adapter. So we do that.
//
// Strategy (best-effort — never blocks the launch):
//   1. Resolve the `bs` path (absolute, or via `which`).
//   2. `codesign -d --entitlements - <bs>` — if stdout contains
//      `com.apple.security.cs.debugger`, we're done.
//   3. Otherwise write an embedded entitlements file to tmpdir and
//      run `codesign -s - --force --entitlements <tmp> <bs>`.
//   4. If signing fails, log to the BugStalker output channel and
//      let `bs` spawn anyway — it will return the descriptive
//      `DarwinDebuggerEntitlementMissing` error which now includes
//      the absolute binary path the user can copy-paste.
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutputChannel } from 'vscode';

const execFileP = promisify(execFile);

// Mirrored from BugStalker's tests/darwin.entitlements. Kept here
// rather than read from disk so the extension self-heal works
// regardless of whether the user has the BugStalker source tree
// alongside the installed binary.
const ENTITLEMENTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.debugger</key>
    <true/>
    <key>com.apple.security.get-task-allow</key>
    <true/>
</dict>
</plist>
`;

async function resolveBsPath(bs: string): Promise<string | undefined> {
    if (path.isAbsolute(bs)) return bs;
    try {
        const { stdout } = await execFileP('/usr/bin/which', [bs]);
        const resolved = stdout.trim();
        return resolved.length > 0 ? resolved : undefined;
    } catch {
        return undefined;
    }
}

async function hasDebuggerEntitlement(bsPath: string): Promise<boolean> {
    try {
        // codesign writes the entitlements XML to stdout; -d omits
        // a designated requirement string. If the binary isn't
        // signed at all, this exits non-zero — caught below.
        const { stdout } = await execFileP('/usr/bin/codesign', [
            '-d', '--entitlements', '-', bsPath,
        ]);
        return stdout.includes('com.apple.security.cs.debugger');
    } catch {
        return false;
    }
}

export async function ensureBsEntitled(
    bsExe: string,
    log: OutputChannel,
): Promise<void> {
    if (process.platform !== 'darwin') return;

    const bsPath = await resolveBsPath(bsExe);
    if (!bsPath) return; // let spawn fail naturally if PATH lookup fails

    if (await hasDebuggerEntitlement(bsPath)) return;

    log.appendLine(
        `[${new Date().toISOString()}] auto-resign: cs.debugger entitlement missing on ${bsPath} — codesigning...`,
    );

    const tmp = path.join(os.tmpdir(), `bs-darwin-${process.pid}.entitlements`);
    try {
        fs.writeFileSync(tmp, ENTITLEMENTS_XML);
        await execFileP('/usr/bin/codesign', [
            '-s', '-', '--force',
            '--entitlements', tmp,
            bsPath,
        ]);
        log.appendLine(
            `[${new Date().toISOString()}] auto-resign: signed ${bsPath}`,
        );
    } catch (e: any) {
        log.appendLine(
            `[${new Date().toISOString()}] auto-resign: codesign failed — ${e?.message ?? String(e)}. ` +
                `bs will start anyway; expect a DarwinDebuggerEntitlementMissing error with manual remediation steps.`,
        );
        log.show(true);
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
}
