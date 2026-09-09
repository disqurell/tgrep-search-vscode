/* All file names, results and logs enter the DOM through text nodes, never HTML. */
(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  const localization = JSON.parse(el('localization').textContent);
  const t = (message, ...args) => (Object.hasOwn(localization.messages, message) ? localization.messages[message] : message)
    .replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < args.length ? String(args[Number(index)]) : placeholder);
  // Translate only our static text/attributes, before results or file paths arrive.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) continue;
    const content = node.textContent.trim();
    if (content) node.textContent = node.textContent.replace(content, () => t(content));
  }
  document.querySelectorAll('[title], [aria-label], [placeholder]').forEach(element => {
    for (const attr of ['title', 'aria-label', 'placeholder']) if (element.hasAttribute(attr)) element.setAttribute(attr, t(element.getAttribute(attr)));
  });
  const controls = ['query', 'glob', 'mode', 'regex', 'caseSensitive'];
  const saved = vscode.getState() || {};
  // Keep search options, but start with a compact interface on every load.
  let settingsCollapsed = true;
  for (const id of controls) if (saved[id] !== undefined) el(id)[el(id).type === 'checkbox' ? 'checked' : 'value'] = saved[id];
  const values = () => Object.fromEntries(controls.map(id => [id, el(id)[el(id).type === 'checkbox' ? 'checked' : 'value']]));
  const persist = () => vscode.setState(values());
  function renderSettings() {
    el('indexDetails').hidden = settingsCollapsed;
    el('configuration').hidden = settingsCollapsed;
    el('settingsHeading').hidden = settingsCollapsed;
    el('compactStatus').hidden = !settingsCollapsed;
    el('toggleSettings').textContent = settingsCollapsed ? t("Settings") : t("Collapse");
    el('toggleSettings').setAttribute('aria-label', settingsCollapsed ? t("Expand settings") : t("Collapse settings"));
    el('toggleSettings').setAttribute('aria-expanded', String(!settingsCollapsed));
    document.body.classList.toggle('settings-collapsed', settingsCollapsed);
  }
  renderSettings();
  el('toggleSettings').addEventListener('click', () => {
    settingsCollapsed = !settingsCollapsed; renderSettings(); persist();
  });
  function modeChanged() {
    const files = el('mode').value === 'files';
    el('regex').disabled = files;
    el('queryLabel').textContent = files ? t("Name / path (glob; empty lists all files)") : t("Query");
    el('query').placeholder = files ? '**/*config*.php' : t("Text or regular expression");
  }
  modeChanged();
  controls.forEach(id => el(id).addEventListener('input', () => { persist(); modeChanged(); }));
  for (const type of ['source', 'project', 'index', 'refresh', 'build', 'cancelBuild', 'cancel', 'log']) {
    el(type).addEventListener('click', () => { el('error').hidden = true; vscode.postMessage({ type }); });
  }
  el('searchForm').addEventListener('submit', event => {
    event.preventDefault(); persist(); el('error').hidden = true;
    vscode.postMessage({ type: 'search', ...values() });
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'state') {
      for (const [id, value] of [['sourcePath', message.binding?.root], ['indexPath', message.binding?.index]]) {
        el(id).textContent = value ? value.split(/[\\/]/).pop() + ' — ' + value : t("not selected");
        el(id).title = value || t("not selected");
        el(id).setAttribute('aria-label', value || t("not selected"));
      }
      el('updated').textContent = message.time;
      el('state').textContent = message.detail;
      el('state').dataset.state = message.state;
      const busy = message.building || message.state === 'busy';
      el('indexIcon').textContent = busy ? '↻' : message.state === 'ready' ? '✓' : '⚠';
      el('compactStatus').dataset.state = message.state;
      const date = new Date(message.indexedAt || '');
      const estimated = message.timeKind === 'metadata' || message.timeKind === 'mtime';
      el('compactUpdated').textContent = Number.isFinite(date.getTime()) ? `${estimated ? '≈ ' : ''}${date.toLocaleString(localization.language)}` : t("unknown");
      const description = t('{0}\nLast successful update: {1}\nSource: {2}\nIndex: {3}', message.detail, message.time, message.binding?.root || t('not selected'), message.binding?.index || t('not selected'));
      el('compactStatus').title = description;
      el('compactStatus').setAttribute('aria-label', description);
      for (const id of ['source', 'project', 'index', 'build']) el(id).disabled = message.building || (id !== 'source' && id !== 'project' && !message.binding);
      el('search').disabled = message.building;
      el('cancelBuild').hidden = !message.building;
      if (!message.building) el('buildLog').hidden = true;
    } else if (message.type === 'focus') {
      if (message.query !== undefined) {
        el('query').value = message.query; el('regex').checked = false; el('caseSensitive').checked = true; el('glob').value = ''; el('mode').value = 'content'; persist(); modeChanged();
      }
      el('query').focus(); el('query').select();
    } else if (message.type === 'error') {
      el('error').hidden = false; el('error').textContent = message.message;
    } else if (message.type === 'log') {
      el('buildLog').hidden = false;
      el('buildLog').textContent = (el('buildLog').textContent + message.text).slice(-4000);
      el('buildLog').scrollTop = el('buildLog').scrollHeight;
    } else if (message.type === 'results') {
      el('summary').textContent = message.message;
      el('cancel').disabled = !message.searching;
      el('results').setAttribute('aria-busy', String(message.searching));
      const fragment = document.createDocumentFragment();
      const groups = new Map();
      message.matches.forEach((match, id) => {
        let group = groups.get(match.path);
        if (!group) {
          group = document.createElement('details'); group.open = true;
          const title = document.createElement('summary');
          title.textContent = match.path.startsWith(message.root + '/') ? match.path.slice(message.root.length + 1) : match.path;
          title.title = match.path; group.append(title); groups.set(match.path, group); fragment.append(group);
        }
        const button = document.createElement('button'); button.className = 'match';
        button.addEventListener('click', () => vscode.postMessage({ type: 'open', id }));
        if (message.mode === 'files') button.textContent = t("Open file");
        else {
          const number = document.createElement('span'); number.className = 'line-number'; number.textContent = String(match.line + 1); button.append(number);
          let offset = 0;
          // Keep the full line for navigation in the host, bound DOM rendering per row.
          const previewLimit = 2000;
          for (const span of match.spans) {
            if (span.start >= previewLimit) break;
            button.append(document.createTextNode(match.text.slice(offset, span.start)));
            const mark = document.createElement('mark'); mark.textContent = match.text.slice(span.start, Math.min(span.end, previewLimit)); button.append(mark);
            offset = Math.min(span.end, previewLimit);
          }
          button.append(document.createTextNode(match.text.slice(offset, previewLimit) + (match.text.length > previewLimit ? ' …' : '')));
          button.setAttribute('aria-label', t('Line {0}: {1}', match.line + 1, match.text.slice(0, 300)));
        }
        group.append(button);
      });
      el('results').replaceChildren(fragment);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
