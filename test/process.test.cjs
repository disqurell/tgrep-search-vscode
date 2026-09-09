const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runGuard } = require('../dist/core');
async function script(t, content) {
  await fs.mkdir('.scratch', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.scratch/process-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stub.py'); await fs.writeFile(file, content); return file;
}
test('missing Python gives actionable error and does not hang', async () => {
  const job = runGuard('/nonexistent/python3', 'none.py', {}, () => {});
  await assert.rejects(job.done, /pythonExecutable/);
});
test('nonzero and no-match exits preserve exit status and bounded diagnostics', async t => {
  const file = await script(t, "import sys\nsys.stdin.readline()\nsys.stderr.write('bad regex')\nsys.exit(2)\n");
  const result = await runGuard('python3', file, {}, () => {}).done;
  assert.equal(result.code, 2); assert.equal(result.stderr, 'bad regex');
});
test('cancellation kills stubborn process group and awaits close', async t => {
  const file = await script(t, "import signal, sys, time\nsys.stdin.readline()\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint('ready', flush=True)\ntime.sleep(60)\n");
  let ready;
  const started = new Promise(resolve => ready = resolve);
  const job = runGuard('python3', file, {}, () => ready());
  await started; job.cancel();
  const result = await job.done; assert(result.cancelled); assert(!result.limited);
});
test('parser error terminates the subprocess and rejects instead of returning partial success', async t => {
  const file = await script(t, "import sys, time\nsys.stdin.readline()\nprint('invalid', flush=True)\ntime.sleep(60)\n");
  const job = runGuard('python3', file, {}, () => { throw new Error('bad JSON'); });
  await assert.rejects(job.done, /bad JSON/);
});
