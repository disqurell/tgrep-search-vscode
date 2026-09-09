// Local equivalent of the Linux CI jobs; isolates generated files within .scratch.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const target = process.argv[2];
if (!/^(linux|alpine)-(x64|arm64)$/.test(target)) throw new Error('Pass linux-x64, linux-arm64, alpine-x64 or alpine-arm64');
const base = path.resolve('.scratch', 'container-' + target);
const args = ['run', '--rm', '--platform', target.endsWith('x64') ? 'linux/amd64' : 'linux/arm64', '-v', `${process.cwd()}:/work:ro`, '-w', '/work', '-e', `TGREP_TARGET=${target}`];
for (const name of ['node_modules', 'dist', '.scratch', 'artifacts']) {
  const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
  args.push('-v', `${dir}:/work/${name}`);
}
args.push(target.startsWith('alpine-') ? 'node:22-alpine' : 'node:22-bullseye', 'sh', '-ec', `
  ${target.startsWith('alpine-') ? 'apk add --no-cache build-base git' : ''}
  npm ci --ignore-scripts
  npm test
  node scripts/download-test-tgrep.cjs
  node --test test/integration.cjs
  node scripts/package.cjs
  node test/package.cjs
`);
const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
fs.mkdirSync('artifacts', { recursive: true });
for (const file of fs.readdirSync(path.join(base, 'artifacts'))) fs.copyFileSync(path.join(base, 'artifacts', file), path.join('artifacts', file));
