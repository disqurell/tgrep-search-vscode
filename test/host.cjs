const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
(async () => {
  const base = path.resolve('.scratch/host');
  const root = path.join(base, 'corpus');
  await fs.mkdir(path.join(root, '.default'), { recursive: true });
  // Isolate discovery from the parent repository's ignored .scratch directory.
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.settings.php'), 'Я🙂 needle🔥\n');
  await fs.writeFile(path.join(root, '.default/config.php'), 'needle🔥\n');
  const executable = process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, TGREP_DEBUG_PORT: String(port), TGREP_TEST_ROOT: root, TGREP_TEST_DATA: path.join(base, 'userdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  const extensionPath = path.resolve(process.env.TGREP_EXTENSION_PATH || process.cwd());
  const child = spawn(executable, [root, '--locale=' + (process.env.TGREP_TEST_LANGUAGE || 'en'), '--remote-debugging-port=' + port, '--user-data-dir=' + env.TGREP_TEST_DATA, '--extensions-dir=' + path.join(base, 'extensions'), '--extensionDevelopmentPath=' + extensionPath, '--extensionTestsPath=' + path.resolve('test/host-suite.cjs'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions'], { env, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill('SIGTERM'); console.error('Extension Host test timeout'); }, 90000);
  child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
})().catch(error => { console.error(error); process.exitCode = 1; });
