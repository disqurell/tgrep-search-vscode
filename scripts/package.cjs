const { mkdirSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');
const { platformTarget, helperRelativePath, TARGETS } = require('../dist/platform');
const target = process.env.TGREP_TARGET || platformTarget();
if (!TARGETS.includes(target)) throw new Error(`Unsupported target: ${target}`);
if (!existsSync(helperRelativePath(target))) throw new Error('Compile the target helper before packaging.');
mkdirSync('artifacts', { recursive: true });
mkdirSync('.scratch', { recursive: true });
const ignoreFile = `.scratch/package-${target}.ignore`;
writeFileSync(ignoreFile, readFileSync('.vscodeignore', 'utf8') + `\ndist/native/**\n!${helperRelativePath(target).split(require('node:path').sep).join('/')}\n`);
// Invoke the JS entry point directly: Windows .cmd shims would require a shell.
const result = spawnSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--ignoreFile', ignoreFile, '--no-dependencies', '--target', target, '-o', `artifacts/tgrep-search-${version}-${target}.vsix`], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
