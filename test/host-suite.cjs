const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
exports.run = async function () {
  if (process.env.TGREP_TEST_NO_TOOLS === '1') {
    const emptyPath = path.resolve('.scratch/host/no-tools');
    await fs.mkdir(emptyPath, { recursive: true });
    process.env.PATH = emptyPath;
  }
  const extension = vscode.extensions.getExtension('local-tools.tgrep-search');
  assert(extension, 'extension is discoverable');
  assert(!Object.hasOwn(extension.packageJSON.contributes.configuration.properties, 'tgrepSearch.pythonExecutable'));
  if (process.env.TGREP_TEST_NO_TOOLS === '1') {
    await vscode.workspace.getConfiguration('tgrepSearch').update('executable', process.env.TGREP_EXECUTABLE || path.join(require('node:os').homedir(), '.local/bin/tgrep'), vscode.ConfigurationTarget.Workspace);
  }
  await extension.activate(); assert(extension.isActive);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['open', 'selection', 'rebuild', 'refresh']) assert(commands.includes('tgrepSearch.' + command));
  await vscode.commands.executeCommand('tgrepSearch.open');
  await vscode.commands.executeCommand('tgrepSearch.rebuild');
  const root = await fs.realpath(process.env.TGREP_TEST_ROOT);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
  const index = path.join(process.env.TGREP_TEST_DATA, 'User/globalStorage/local-tools.tgrep-search/indexes', hash);
  const receipt = JSON.parse(await fs.readFile(path.join(index, '.tgrep-search-completed.json'), 'utf8'));
  assert.equal(receipt.root, root); assert(Number.isFinite(Date.parse(receipt.completedAt)));
  const document = await vscode.workspace.openTextDocument(path.join(root, '.settings.php'));
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 4, 0, 12);
  assert.equal(document.getText(editor.selection), 'needle🔥');
  await vscode.commands.executeCommand('tgrepSearch.selection');
  await vscode.commands.executeCommand('tgrepSearch.refresh');
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.TGREP_DEBUG_PORT);
  try {
    const session = await browser.newBrowserCDPSession();
    const targets = (await session.send('Target.getTargets')).targetInfos;

    let requestId = 0;
    const pending = new Map();
    session.on('Target.receivedMessageFromTarget', event => {
      const result = JSON.parse(event.message);
      if (result.id && pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
    });
    async function rpc(sessionId, method, params = {}) {
      const id = ++requestId;
      const result = new Promise(resolve => pending.set(id, resolve));
      await session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
      const response = await result;
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result;
    }
    let targetSession;
    for (const target of targets) {
      if (!['iframe', 'webview', 'page'].includes(target.type)) continue;
      const attached = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      const result = await rpc(attached.sessionId, 'Runtime.evaluate', { expression: 'Boolean(document.getElementById("active-frame")?.contentDocument?.getElementById("query"))', returnByValue: true });
      if (result.result.value) { targetSession = attached.sessionId; break; }
    }
    assert(targetSession, 'real VS Code webview DOM accessible');
    const evaluate = async expression => (await rpc(targetSession, 'Runtime.evaluate', { expression: '((document) => eval(' + JSON.stringify(expression) + '))(window.document.getElementById("active-frame").contentDocument)', returnByValue: true })).result.value;
    assert(await evaluate('document.getElementById("configuration").hidden'));
    await evaluate('document.getElementById("toggleSettings").click()');
    for (let i = 0; i < 100 && await evaluate('document.querySelectorAll(".match").length') !== 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.querySelectorAll(".match").length'), 2);
    assert.equal(await evaluate('document.querySelector("mark").textContent'), 'needle🔥');
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await evaluate('[...document.querySelectorAll(".match")].find(e => e.textContent.includes("Я")).click()');
    await new Promise(resolve => setTimeout(resolve, 200));
    const navigated = vscode.window.activeTextEditor;
    assert.equal(navigated.document.fileName, path.join(root, '.settings.php'));
    assert.equal(navigated.selection.start.character, 4);
    assert.equal(navigated.selection.end.character, 12);
    assert.equal(navigated.document.getText(navigated.selection), 'needle🔥');
    await evaluate('document.getElementById("query").value = "-absent"; document.getElementById("query").focus()');
    await evaluate('document.getElementById("search").click()');
    for (let i = 0; i < 100 && !await evaluate('document.getElementById("summary").textContent.includes("no matches")'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert(await evaluate('document.getElementById("summary").textContent.includes("no matches")'));
    await evaluate('document.getElementById("query").value = "needle🔥"; document.getElementById("search").click()');
    for (let i = 0; i < 100 && await evaluate('document.querySelectorAll(".match").length') !== 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
    await browser.contexts()[0].pages()[0].screenshot({ path: path.resolve('.scratch/host/vscode-host.png') });
    await evaluate('document.getElementById("toggleSettings").click()');
    assert(await evaluate('document.getElementById("configuration").hidden'));
    assert.equal(await evaluate('document.getElementById("indexIcon").textContent'), '✓');
    assert((await evaluate('document.getElementById("compactUpdated").textContent')).includes(String(new Date().getFullYear())));
    await browser.contexts()[0].pages()[0].screenshot({ path: path.resolve('.scratch/host/vscode-compact.png') });
    await evaluate('document.getElementById("toggleSettings").click()');
    assert(!await evaluate('document.getElementById("configuration").hidden'));
    const config = vscode.workspace.getConfiguration('tgrepSearch');
    const originalLanguage = config.get('language');
    try {
      await config.update('language', 'ru', vscode.ConfigurationTarget.Workspace);
      for (let i = 0; i < 100 && await evaluate('document.getElementById("query")?.placeholder') !== 'Текст или регулярное выражение'; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate('document.getElementById("query").placeholder'), 'Текст или регулярное выражение');
      assert(await evaluate('document.getElementById("configuration").hidden'));
      await config.update('language', 'en', vscode.ConfigurationTarget.Workspace);
      for (let i = 0; i < 100 && await evaluate('document.getElementById("query")?.placeholder') !== 'Text or regular expression'; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await evaluate('document.getElementById("query").placeholder'), 'Text or regular expression');
      assert.equal(await evaluate('document.getElementById("query").value'), 'needle🔥');
    } finally { await config.update('language', originalLanguage, vscode.ConfigurationTarget.Workspace); }
  } finally { await browser.close(); }
  console.log('HOST PASSED (empty PATH: ' + (process.env.TGREP_TEST_NO_TOOLS === '1') + '): real webview DOM, search by button, Unicode editor navigation, no matches, collapsed default, live language switch, collapse/expand with date; activation, contributions, webview open, actual build + receipt, selection search, refresh.');
};
