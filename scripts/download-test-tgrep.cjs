// Development/CI only. Runtime never downloads executables.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { platformTarget } = require('../dist/platform');
const releases = {
  'darwin-arm64': ['aarch64-apple-darwin.tar.gz', 'aa7644819d3a6e0202013e6c7c2be2623d5a2bef710249c0b31cc00aa80e19ad'],
  'darwin-x64': ['x86_64-apple-darwin.tar.gz', 'a0352e5648ae4c744e344cead5d3b87e7ab3a12c060928db87c379c12036a210'],
  'win32-arm64': ['aarch64-pc-windows-msvc.zip', 'f49b68f97810530688a8fe71282dfc384ed4ff99ffe7a8a769e43e68a7c633fe'],
  'win32-x64': ['x86_64-pc-windows-msvc.zip', '5b6ba08ffddb5bc1b436c5c83b4f0c9e66c70a006b3853ed57daf51e7a75986c'],
  'linux-arm64': ['aarch64-unknown-linux-musl.tar.gz', '4d8d6c3cd6c2ca9055f5ab62473e7d772c6383e091a2065d4c5d0fd6d1540639'],
  'linux-x64': ['x86_64-unknown-linux-musl.tar.gz', '072b8b5db49bd76d19d2466c1494e579baf4d8a7c74397c9e54c11018f79d333']
};
(async () => {
  const target = (process.argv[2] || platformTarget()).replace('alpine-', 'linux-');
  const [asset, sha] = releases[target];
  const response = await fetch(`https://github.com/microsoft/tgrep/releases/download/v1.0.5/tgrep-v1.0.5-${asset}`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('tgrep archive checksum mismatch');
  const directory = path.resolve('.scratch', 'tgrep-' + target); fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, asset); fs.writeFileSync(archive, bytes);
  if (asset.endsWith('.zip')) await require('./unzip.cjs')(archive, directory);
  else {
    const extracted = spawnSync('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' });
    if (extracted.error || extracted.status !== 0) throw extracted.error || new Error('Extraction failed');
  }
  const filename = target.startsWith('win32-') ? 'tgrep.exe' : 'tgrep';
  const files = fs.readdirSync(directory, { recursive: true });
  const relative = files.find(name => path.basename(name) === filename);
  if (!relative) throw new Error('Archive has no tgrep executable');
  const executable = path.join(directory, relative); fs.chmodSync(executable, 0o755);
  fs.writeFileSync('.scratch/tgrep-path.txt', executable);
  console.log(`Verified tgrep 1.0.5 for ${target}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
