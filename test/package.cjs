const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { platformTarget, helperRelativePath } = require('../dist/platform');
const { version } = require('../package.json');
(async () => {
const target = platformTarget();
const archive = path.resolve(`artifacts/tgrep-search-${version}-${target}.vsix`);
const directory = path.resolve('.scratch', 'package-' + target); fs.mkdirSync(directory, { recursive: true });
await require('../scripts/unzip.cjs')(archive, directory);
const extension = path.join(directory, 'extension');
const manifest = fs.readFileSync(path.join(directory, 'extension.vsixmanifest'), 'utf8');
assert(manifest.includes(`TargetPlatform="${target}"`));
assert.deepEqual(fs.readdirSync(path.join(extension, 'dist/native')), [target]);
const helper = path.join(extension, helperRelativePath());
fs.accessSync(helper, fs.constants.X_OK);
assert(!fs.existsSync(path.join(extension, 'scripts')));
assert(!fs.existsSync(path.join(extension, '.github')));
// Reuse the real integration contract against the extracted artifact, with no
// tool directory on PATH. Only tgrep (absolute path) and bundled helper may run.
const executable = process.env.TGREP_EXECUTABLE || fs.readFileSync('.scratch/tgrep-path.txt', 'utf8');
const env = { ...process.env, TGREP_PACKAGED_EXTENSION: extension, TGREP_EXECUTABLE: executable, PATH: '' };
const tested = spawnSync(process.execPath, ['--test', 'test/integration.cjs'], { env, stdio: 'inherit' });
if (tested.error || tested.status !== 0) throw tested.error || new Error('Packaged runtime test failed');
console.log(`PASS: ${target} VSIX, platform selection, executable mode, isolated contents, real tgrep with empty PATH`);

})().catch(error => { console.error(error); process.exitCode = 1; });
