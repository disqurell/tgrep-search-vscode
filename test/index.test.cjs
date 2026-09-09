const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspect, fingerprint, DIRTY, RECEIPT } = require('../dist/index');
async function fixture(t) {
  await fs.mkdir('.scratch', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.scratch/index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binding = { root: path.join(dir, 'root'), index: path.join(dir, 'index') };
  await fs.mkdir(binding.root); await fs.mkdir(binding.index);
  const meta = { version: 2, root_path: binding.root, num_files: 0, num_trigrams: 0, complete: true, updated_at: 1700000000 };
  for (const file of ['index.bin','lookup.bin','files.bin']) await fs.writeFile(path.join(binding.index,file),'');
  const save = () => fs.writeFile(path.join(binding.index,'meta.json'), JSON.stringify(meta));
  await save();
  return { ...binding, dir, meta, save };
}
test('root binding and symlink aliases are validated', async t => {
  const f = await fixture(t);
  assert.equal((await inspect(f)).state, 'ready');
  assert.equal((await inspect({ ...f, root: f.dir })).state, 'mismatch');
  const alias = path.join(f.dir, 'alias'); await fs.symlink(f.root, alias); f.meta.root_path = alias; await f.save();
  assert.equal((await inspect(f)).state, 'ready');
});
test('incomplete, dirty, server and corrupt indexes are blocked', async t => {
  const f = await fixture(t);
  f.meta.complete = false; await f.save(); assert.equal((await inspect(f)).state, 'error');
  f.meta.complete = true; await f.save();
  for (const file of [DIRTY, 'serve.json']) {
    await fs.writeFile(path.join(f.index,file),'{}'); assert.equal((await inspect(f)).state,'error'); await fs.unlink(path.join(f.index,file));
  }
  await fs.writeFile(path.join(f.index,'lookup.bin'),'x'); assert.equal((await inspect(f)).state,'error');
});
test('confirmed completion expires after external update, with nanosecond fingerprints', async t => {
  const f = await fixture(t);
  const receipt = { schema: 2, root: f.root, completedAt: '2026-01-01T00:00:00.000Z', fingerprint: await fingerprint(f.index) };
  await fs.writeFile(path.join(f.index, RECEIPT),JSON.stringify(receipt));
  assert.equal((await inspect(f)).timeKind,'completed');
  f.meta.updated_at += 30; await f.save();
  const state = await inspect(f); assert.equal(state.timeKind,'metadata'); assert.notEqual(state.time,receipt.completedAt);
  assert.equal(typeof receipt.fingerprint['meta.json'][2], 'string');
});
test('mtime fallback, missing index, and old receipt migration never invent completion', async t => {
  const f = await fixture(t);
  delete f.meta.updated_at; await f.save(); assert.equal((await inspect(f)).timeKind,'mtime');
  await fs.writeFile(path.join(f.index,RECEIPT), JSON.stringify({ root:f.root,completedAt:'2026-01-01T00:00:00Z',fingerprint:await fingerprint(f.index) }));
  assert.equal((await inspect(f)).timeKind,'mtime');
  await fs.unlink(path.join(f.index,'meta.json')); assert.equal((await inspect(f)).time,null);
});
test('a partial external generation is rejected even with a valid old receipt', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.index, RECEIPT),JSON.stringify({ schema:2, root:f.root, completedAt:'2026-01-01T00:00:00Z',fingerprint:await fingerprint(f.index) }));
  const future = new Date(Date.now()+10000); await fs.utimes(path.join(f.index,'files.bin'),future,future);
  const state = await inspect(f); assert.equal(state.state,'error'); assert.equal(state.timeLastKnown,true);
});
