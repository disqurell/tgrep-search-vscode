const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
mkdirSync('artifacts', { recursive: true });
const result = spawnSync('vsce', ['package', '--no-dependencies', '--target', 'darwin-arm64', '-o', `artifacts/tgrep-search-${version}.vsix`], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
