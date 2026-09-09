const { mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { platformTarget, helperRelativePath, TARGETS } = require('../dist/platform');
const target = process.env.TGREP_TARGET || platformTarget();
if (!TARGETS.includes(target)) throw new Error(`Unsupported target: ${target}`);
const output = helperRelativePath(target);
mkdirSync(path.dirname(output), { recursive: true });
let compiler, args;
if (target.startsWith('win32-')) {
  if (process.platform !== 'win32') throw new Error('Build Windows helpers in a Visual Studio Developer shell on Windows.');
  compiler = 'cl.exe';
  args = ['/nologo', '/std:c11', '/O2', '/W4', '/WX', '/MT', '/utf-8', '/DUNICODE', '/D_UNICODE', 'native/guard-win.c', `/Fe:${output}`, `/Fo:${path.dirname(output)}/guard.obj`, '/link', 'kernel32.lib'];
} else {
  compiler = process.env.CC || 'cc';
  args = ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_DARWIN_C_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror'];
  if (target.startsWith('darwin-')) {
    if (process.platform !== 'darwin') throw new Error('Build macOS helpers on macOS.');
    args.push('-arch', target.endsWith('arm64') ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0');
  } else {
    if (target !== platformTarget()) throw new Error('Build Linux/Alpine helpers on their matching architecture and libc.');
    // musl produces a standalone binary. glibc builds use the CI runner baseline.
    if (target.startsWith('alpine-')) args.push('-static');
  }
  args.push('native/guard.c', '-o', output);
}
const result = spawnSync(compiler, args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Built ${target}: ${output}`);
