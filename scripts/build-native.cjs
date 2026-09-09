const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This package currently targets macOS Apple Silicon (darwin-arm64).');
}
mkdirSync('dist/native', { recursive: true });
const result = spawnSync('clang', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=11.0', 'native/guard.c', '-o', 'dist/native/guard'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
