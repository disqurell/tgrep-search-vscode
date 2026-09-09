const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const http = require('node:http');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const html = (await fs.readFile('media/panel.html', 'utf8')).replaceAll('{{csp}}', "'self'").replace("style-src 'self';", "style-src 'self' 'nonce-testnonce';").replaceAll('{{nonce}}', 'testnonce').replace('{{style}}', '/panel.css').replace('{{script}}', '/panel.js').replace('</head>', '<link rel="stylesheet" href="/theme.css"></head>');
  const server = http.createServer(async (req, res) => {
    const name = req.url.slice(1);
    if (name === 'theme.css') { res.setHeader('Content-Type', 'text/css'); res.end(':root { --vscode-foreground: #ccc; --vscode-sideBar-background: #252526; --vscode-input-background: #3c3c3c; --vscode-input-foreground: #ccc; --vscode-button-background: #0e639c; --vscode-button-foreground: white; --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: white; --vscode-descriptionForeground: #aaa; --vscode-testing-iconPassed: #89d185; --vscode-panel-border: #454545; --vscode-font-family: system-ui; }'); }
    else if (['panel.css', 'panel.js'].includes(name)) { res.setHeader('Content-Type', name.endsWith('css') ? 'text/css' : 'text/javascript'); res.end(await fs.readFile(path.join('media', name))); }
    else { res.setHeader('Content-Type', 'text/html'); const language = req.url === '/en' ? 'en' : 'ru'; res.end(html.replace('{{language}}', language).replace('{{localization}}', () => JSON.stringify({ language, messages: language === 'ru' ? require('../media/l10n.ru.json') : {} }).replaceAll('<', '\\u003c'))); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 1100 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.addInitScript(() => {
      window.sent = [];
      if (!sessionStorage.getItem('viewState')) sessionStorage.setItem('viewState', JSON.stringify({ settingsCollapsed: true }));
      window.acquireVsCodeApi = () => ({ postMessage: data => window.sent.push(data), getState: () => JSON.parse(sessionStorage.getItem('viewState') || '{}'), setState: value => sessionStorage.setItem('viewState', JSON.stringify(value)) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert(await page.locator('#configuration').isHidden());
    assert.equal(await page.locator('#toggleSettings').getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: 'Развернуть настройки', exact: true }).click();
    const post = data => page.evaluate(data => window.postMessage(data, '*'), data);
    const readyState = { type: 'state', binding: { root: '/workspace/project', index: '/cache/project-index' }, detail: 'Индекс есть · 225941 файлов', state: 'ready', time: '09.09.2026, 15:39:28 (meta.updated_at, оценка завершения внешней сборки)', indexedAt: '2026-09-09T13:39:28Z', timeKind: 'metadata', building: false };
    await post(readyState);
    await page.getByLabel('Запрос', { exact: true }).fill('-needle🔥');
    await page.getByLabel('Запрос', { exact: true }).press('Enter');
    assert.equal((await page.evaluate(() => window.sent.find(m => m.type === 'search'))).query, '-needle🔥');
    const malicious = '<img src=x onerror="window.pwned=true">';
    await post({ type: 'results', root: '/workspace/project', message: '2 строки · 0.14 с', searching: false, mode: 'content', matches: [
      { path: '/workspace/project/.settings.php', line: 147, text: 'Я🙂 needle🔥', spans: [{ start: 4, end: 12 }] },
      { path: '/workspace/project/.default/' + malicious + '.php', line: 77, text: malicious, spans: [] }
    ] });
    await page.locator('.match').first().waitFor();
    assert.equal(await page.locator('mark').textContent(), 'needle🔥');
    assert.equal(await page.locator('#results img').count(), 0);
    await page.locator('.match').first().focus();
    await page.keyboard.press('Enter');
    assert.deepEqual((await page.evaluate(() => window.sent.filter(m => m.type === 'open').at(-1))), { type: 'open', id: 0 });
    await page.getByRole('button', { name: 'Выбрать исходники…' }).click();
    await page.getByRole('button', { name: 'Выбрать папку индекса…' }).click();
    assert((await page.evaluate(() => window.sent)).some(m => m.type === 'source'));
    assert((await page.evaluate(() => window.sent)).some(m => m.type === 'index'));
    await page.locator('#mode').selectOption('files');
    assert(await page.locator('#regex').isDisabled());
    await page.locator('#mode').selectOption('content');
    await fs.mkdir('artifacts', { recursive: true });
    await page.locator('#results details').nth(1).locator('summary').evaluate(el => el.textContent = '.default/config.php');
    await page.locator('.match').nth(1).evaluate(el => el.textContent = '78  needle🔥');
    await page.screenshot({ path: 'artifacts/panel-ru.png', fullPage: true });
    await page.evaluate(() => { document.getElementById('results').style.minHeight = '2000px'; window.scrollTo(0, 800); });
    assert((await page.locator('.index-status').boundingBox()).y >= 0);
    await page.evaluate(() => { document.getElementById('results').style.minHeight = ''; window.scrollTo(0, 0); });
    await page.setViewportSize({ width: 280, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await post({ type: 'state', binding: { root: '/workspace/project', index: '/cache/project-index' }, detail: 'Индекс строится…', state: 'building', time: '09.09.2026, 15:39:28 (последнее известное)', building: true });
    await page.waitForFunction(() => document.getElementById('search').disabled);
    assert(await page.getByRole('button', { name: 'Отменить сборку' }).isVisible());
    await post({ type: 'error', message: 'Индекс занят внешним обновлением' });
    assert.equal(await page.getByRole('alert').textContent(), 'Индекс занят внешним обновлением');
    await post(readyState);
    await page.getByRole('button', { name: 'Свернуть настройки', exact: true }).focus();
    await page.keyboard.press('Space');
    assert(await page.locator('#indexDetails').isHidden());
    assert(await page.locator('#configuration').isHidden());
    assert(await page.locator('#searchForm').isVisible());
    assert.equal(await page.locator('#indexIcon').textContent(), '✓');
    assert.match(await page.locator('#compactUpdated').textContent(), /≈.*2026/);
    assert.match(await page.locator('#compactStatus').getAttribute('title'), /оценка/);
    assert.equal(await page.locator('#toggleSettings').getAttribute('aria-expanded'), 'false');
    await page.locator('#query').fill('saved query');
    await page.reload();
    assert(await page.locator('#configuration').isHidden());
    assert.equal(await page.locator('#query').inputValue(), 'saved query');
    await post(readyState);
    await page.waitForFunction(() => document.getElementById('indexIcon').textContent === '✓');
    await page.screenshot({ path: 'artifacts/panel-ru-compact.png', fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await post({ ...readyState, state: 'error', detail: 'Индекс повреждён' });
    await page.waitForFunction(() => document.getElementById('indexIcon').textContent === '⚠');
    await post({ ...readyState, state: 'building', building: true });
    await page.waitForFunction(() => document.getElementById('indexIcon').textContent === '↻');
    await page.getByRole('button', { name: 'Развернуть настройки', exact: true }).click();
    assert(await page.getByRole('button', { name: 'Отменить сборку' }).isVisible());
    const english = await browser.newPage({ viewport: { width: 380, height: 950 } });
    english.on('pageerror', error => errors.push(error.message));
    await english.addInitScript(() => {
      window.sent = [];
      window.acquireVsCodeApi = () => ({ postMessage: value => window.sent.push(value), getState: () => ({ settingsCollapsed: true }), setState: () => {} });
    });
    await english.goto(`http://127.0.0.1:${server.address().port}/en`);
    assert(await english.locator('#configuration').isHidden());
    await english.getByRole('button', { name: 'Expand settings', exact: true }).click();
    assert(await english.getByRole('button', { name: 'Choose source folder…', exact: true }).isVisible());
    assert.equal(await english.locator('#query').getAttribute('placeholder'), 'Text or regular expression');
    assert(!/[А-Яа-яЁё]/.test(await english.locator('body').innerText()));
    await english.getByLabel('Query', { exact: true }).fill('needle');
    await english.getByLabel('Query', { exact: true }).press('Enter');
    assert.equal(await english.evaluate(() => window.sent.find(m => m.type === 'search').query), 'needle');
    await english.evaluate(state => window.postMessage(state, '*'), { ...readyState, detail: 'Index ready · 2 files', time: '09/09/2026 (estimated external build completion)' });
    await english.getByRole('button', { name: 'Collapse settings', exact: true }).click();
    assert(await english.locator('#configuration').isHidden());
    assert.match(await english.locator('#compactStatus').getAttribute('title'), /Last successful update/);
    await english.screenshot({ path: 'artifacts/panel-en-compact.png', fullPage: true });
    await english.getByRole('button', { name: 'Expand settings', exact: true }).click();
    await english.screenshot({ path: 'artifacts/panel-en.png', fullPage: true });
    await english.evaluate(css => { const style = document.createElement('style'); style.nonce = 'testnonce'; style.textContent = css; document.head.append(style); }, ':root { --vscode-foreground: #252a32; --vscode-sideBar-background: #f5f6f8; --vscode-input-background: #fff; --vscode-input-foreground: #252a32; --vscode-descriptionForeground: #606775; --vscode-focusBorder: #0069b9; --vscode-input-placeholderForeground: #606775; --vscode-button-background: #0069b9; --vscode-button-foreground: #fff; }');
    await english.getByRole('button', { name: 'Collapse settings', exact: true }).click();
    await english.screenshot({ path: 'artifacts/panel-light.png', fullPage: true });
    await english.evaluate(() => document.body.classList.add('vscode-high-contrast-light'));
    assert.equal(await english.locator('body').evaluate(el => getComputedStyle(el).getPropertyValue('--wash').trim()), 'transparent');
    await english.close();
    assert.deepEqual(errors, []);
    console.log('UI passed: existing search scenarios + compact settings, keyboard toggle, collapsed default after reload, EN/RU localization, date/estimate, error/build icons, 280px layout; artifacts/panel-ru-compact.png');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
