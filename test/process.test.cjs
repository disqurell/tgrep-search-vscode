const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nativeSession, BusyError } = require('../dist/native');
const helper = path.resolve('dist/native/guard');
async function fixture(t) {
  await fs.mkdir('.scratch', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.scratch/process-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const locks = [path.join(dir, 'internal.lock'), path.join(dir, 'external.lock')];
  const session = (code = '', exclusive = false, onData = () => {}) => nativeSession(helper, locks, exclusive, dir, code ? [process.execPath, '-e', code] : [], onData);
  return { dir, locks, session };
}
test('missing bundled helper gives an actionable error without hanging', async t => {
  const { dir, locks } = await fixture(t);
  const session = nativeSession(path.join(dir, 'missing'), locks, false, dir, [], () => {});
  await assert.rejects(session.ready, /Reinstall the extension/); await session.release();
});
test('nonzero and no-match exits preserve exit status and bounded diagnostics', async t => {
  const { session } = await fixture(t);
  for (const code of [1, 2]) {
    const s = session(`process.stderr.write('bad regex'); process.exitCode=${code};`);
    await s.ready;
    const result = await s.run();
    assert.equal(result.code, code); assert.equal(result.stderr, 'bad regex'); await s.release();
  }
});
test('cancellation kills stubborn child group, waits for close, and releases locks', async t => {
  const { session } = await fixture(t);
  let ready; const started = new Promise(resolve => ready = resolve);
  const s = session("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)", true, ready);
  await s.ready; const running = s.run(); await started;
  s.cancel(); const result = await running; assert.equal(result.code, 137); await s.release();
  const next = session('', true); await next.ready; await next.release();
});
test('parser error cancels the subprocess and rejects partial success', async t => {
  const { session } = await fixture(t);
  const s = session("console.log('invalid'); setInterval(()=>{},1000)", false, () => { throw new Error('bad JSON'); });
  await s.ready; await assert.rejects(s.run(), /bad JSON/); await s.release();
});
test('shared locks coexist, block builds, and persist after child exit until release', async t => {
  const { session } = await fixture(t);
  const reader1 = session('process.exit(0)'), reader2 = session();
  await reader1.ready; await reader2.ready;
  assert.equal((await reader1.run()).code, 0);
  const writer = session('', true); await assert.rejects(writer.ready, BusyError); await writer.release();
  await reader1.release(); await reader2.release();
  const exclusive = session('', true); await exclusive.ready;
  const reader = session(); await assert.rejects(reader.ready, BusyError); await reader.release();
  await exclusive.release();
});
test('host death kills the child before releasing the exclusive lock', async t => {
  const { dir, locks, session } = await fixture(t);
  const hostCode = `const {nativeSession}=require(${JSON.stringify(path.resolve('dist/native'))});
    const s=nativeSession(${JSON.stringify(helper)}, ${JSON.stringify(locks)}, true, ${JSON.stringify(dir)},
      [process.execPath,'-e',"process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],
      b=>process.stdout.write(b)); s.ready.then(()=>s.run());`;
  const host = spawn(process.execPath, ['-e', hostCode], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => host.kill('SIGKILL'));
  const pid = await new Promise((resolve, reject) => { host.stdout.once('data', b => resolve(Number(b.toString().trim()))); host.on('error', reject); });
  assert(pid > 0); host.kill('SIGKILL');
  // The stubborn command stays alive through TERM, so its lock must remain held.
  await new Promise(resolve => setTimeout(resolve, 150));
  const blocked = session('', true); await assert.rejects(blocked.ready, BusyError); await blocked.release();
  const deadline = Date.now() + 5000;
  while (true) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    assert(Date.now() < deadline, 'orphan command was not terminated');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const available = session('', true); await available.ready; await available.release();
});
test('cancellation during validation retains locks until the host finishes writes', async t => {
  const { session } = await fixture(t);
  for (const run of [false, true]) {
    const s = session('process.exit(0)', true); await s.ready;
    if (run) assert.equal((await s.run()).code, 0);
    s.cancel(); await new Promise(resolve => setTimeout(resolve, 60));
    const blocked = session('', true); await assert.rejects(blocked.ready, BusyError); await blocked.release();
    await s.release();
    const available = session('', true); await available.ready; await available.release();
  }
});
