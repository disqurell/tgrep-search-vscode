const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runGuard } = require('../dist/core');
const { search, inspectIndex } = require('../dist/service');
const runtime = { python: 'python3', script: path.resolve('scripts/guard.py'), executable: process.env.TGREP_EXECUTABLE || path.join(os.homedir(), '.local/bin/tgrep'), externalLock: '', language: 'ru' };
const q = (query, extra = {}) => ({ query, regex: false, caseSensitive: true, glob: '', mode: 'content', ...extra });
async function build(binding, rt = runtime) {
  return runGuard(rt.python, rt.script, { op: 'build', ...binding, executable: rt.executable, externalLock: rt.externalLock }, () => {}).done;
}
test('real tgrep: hidden, Unicode, dash, glob, no matches, errors, limits, receipt and failed rebuild', async () => {
  await fs.mkdir('.scratch', { recursive: true });
  const temp = await fs.mkdtemp(path.resolve('.scratch/integration-'));
  try {
    const binding = { root: path.join(temp, 'source with spaces'), index: path.join(temp, 'index with spaces') };
    await fs.mkdir(path.join(binding.root, '.default'), { recursive: true });
    await fs.mkdir(path.join(binding.root, '.git'));
    await fs.writeFile(path.join(binding.root, '.settings.php'), 'Я🙂 needle🔥\n-hidden-token\n');
    await fs.writeFile(path.join(binding.root, '.default/config.php'), 'needle🔥\n');
    await fs.writeFile(path.join(binding.root, 'normal.txt'), 'NEEDLE🔥\n' + 'many results\n'.repeat(10000));
    await fs.writeFile(path.join(binding.root, '.git/config'), 'needle🔥');
    await assert.rejects(search(runtime, { ...binding, index: path.join(temp, 'missing-parent/index') }, q('needle'), 1000, 1024 * 1024).result, /Индекс отсутствует/);
    const started = Date.now();
    assert.equal((await build(binding)).code, 0);
    const state = await inspectIndex(runtime, binding).result;
    assert.equal(state.state, 'ready'); assert.equal(state.timeKind, 'completed');
    assert.match((await inspectIndex({ ...runtime, language: 'en' }, binding).result).detail, /^Index ready/);
    assert(Date.parse(state.time) >= started);
    const run = query => search(runtime, binding, query, 1000, 8 * 1024 * 1024).result;
    let result = await run(q('needle🔥'));
    assert.equal(result.matches.length, 2);
    const unicode = result.matches.find(m => m.path.endsWith('.settings.php'));
    assert.deepEqual(unicode.spans, [{ start: 4, end: 12 }]);
    assert.equal((await run(q('-hidden-token'))).matches.length, 1);
    assert.equal((await run(q('needle🔥', { caseSensitive: false }))).matches.length, 3);
    assert.equal((await run(q('needle.*', { regex: true, glob: '**/.default/**' }))).matches.length, 1);
    assert.equal((await run(q('no-such-token'))).matches.length, 0);
    await assert.rejects(run(q('[', { regex: true })), /regex|parse|unclosed|error/i);
    assert.equal((await run(q('**/.settings.php', { mode: 'files' }))).matches.length, 1);
    result = await search(runtime, binding, q('many'), 7, 8 * 1024 * 1024).result;
    assert.equal(result.matches.length, 7); assert(result.limited);
    const cancelled = search(runtime, binding, q('many'), 10000, 8 * 1024 * 1024);
    cancelled.job.cancel(); assert((await cancelled.result).cancelled);
    const before = await fs.readFile(path.join(binding.index, '.tgrep-search-completed.json'), 'utf8');
    const failed = await build(binding, { ...runtime, executable: path.join(temp, 'missing-executable') });
    assert.notEqual(failed.code, 0);
    assert.equal(await fs.readFile(path.join(binding.index, '.tgrep-search-completed.json'), 'utf8'), before);
    assert.equal((await inspectIndex(runtime, binding).result).state, 'error');
    await assert.rejects(run(q('needle')), /не завершена/);
    assert.equal((await build(binding)).code, 0);
    assert.equal((await inspectIndex(runtime, binding).result).state, 'ready');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
