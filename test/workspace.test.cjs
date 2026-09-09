const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const disposable = () => ({ dispose() {} });
const uri = file => ({ fsPath: file, toString: () => 'file://' + file });
async function fixture(t, savedRoot) {
  await fs.mkdir('.scratch', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.scratch/workspace-'));
  const root = path.join(dir, 'root'); await fs.mkdir(root);
  const values = new Map(); let provider;
  const folders = [{ name: 'root', uri: uri(root) }];
  if (savedRoot) values.set('selection:' + JSON.stringify([uri(root).toString()]), path.join(dir, 'deleted-source'));
  const mock = {
    env: { language: 'ru' },
    StatusBarAlignment: { Left: 1 },
    Uri: { file: uri },
    window: {
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerWebviewViewProvider: (_, value) => { provider = value; return disposable(); }
    },
    workspace: {
      workspaceFolders: folders,
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
      onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable
    },
    commands: { registerCommand: disposable }
  };
  const context = {
    subscriptions: [], globalStorageUri: uri(path.join(dir, 'global')),
    asAbsolutePath: relative => path.resolve(relative),
    workspaceState: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: async (key, value) => values.set(key, value) }
  };
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  try { delete require.cache[require.resolve('../dist/extension')]; require('../dist/extension').activate(context); }
  finally { Module._load = original; }
  t.after(async () => { context.subscriptions.forEach(s => s.dispose()); await fs.rm(dir, { recursive: true, force: true }); });
  await provider.initialized;
  return { dir, root, values, provider, mock };
}
test('deleted saved source does not break initialization or prevent choosing another folder', async t => {
  const { provider, root } = await fixture(t, true);
  assert.equal(provider.state.state, 'error');
  await provider.setRoot(root);
  assert.equal(provider.binding.root, root);
  assert.equal(provider.state.state, 'missing');
});
test('source/index bindings survive root switches without leaking to another workspace', async t => {
  const { dir, root, provider, values, mock } = await fixture(t);
  const initial = provider.binding.index;
  const index = path.join(dir, 'external-index'); await fs.mkdir(index);
  await provider.saveIndex(index);
  const otherRoot = path.join(dir, 'other-source'); await fs.mkdir(otherRoot);
  await provider.setRoot(otherRoot);
  assert.notEqual(provider.binding.index, index);
  assert.notEqual(provider.binding.index, initial);
  await provider.setRoot(root);
  assert.equal(provider.binding.index, index);
  // VS Code supplies a different workspaceState for another workspace.
  values.clear(); mock.workspace.workspaceFolders = [{ name: 'other', uri: uri(otherRoot) }];
  await provider.initialize();
  assert.equal(provider.binding.root, otherRoot);
  assert.notEqual(provider.binding.index, index);
  await assert.rejects(provider.saveIndex(otherRoot), /вне папки/);
});
