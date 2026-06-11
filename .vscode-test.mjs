import { defineConfig } from '@vscode/test-cli';

// Runs the real extension inside a downloaded VS Code (headless on CI),
// with full vscode-API access under Mocha. See extension/test/.
export default defineConfig({
    files: 'out/test/**/*.test.js',
    mocha: { ui: 'bdd', timeout: 20000 },
    // Electron startup crashes (SIGTRAP) on this host before the extension
    // host loads; --no-sandbox is the usual macOS/headless remedy, plus
    // --disable-gpu to avoid the GPU-helper FATAL.
    launchArgs: ['--no-sandbox', '--disable-gpu'],
});
