import { t, setLanguage, getLanguage, getMessages } from './i18n';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { Binding, Generation, IndexState, Job, Match, Query, contained, runGuard, timeLabel } from './core';
import { Runtime, inspectIndex, search } from './service';

const expand = (value: string) => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const configureLanguage = () => setLanguage(vscode.workspace.getConfiguration('tgrepSearch').get<string>('language', 'auto'), vscode.env?.language ?? 'en');

class Panel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private binding?: Binding;
  private state?: IndexState;
  private searchJob?: Job;
  private buildJob?: Job;
  private checkJob?: Job;
  private building = false;
  private checking = false;
  private disposed = false;
  private generation = new Generation();
  private matches: Match[] = [];
  private resultMessage = t("Enter a query and press Enter.");
  private searching = false;
  private pendingQuery?: string;
  private lastQuery?: Query;
  private timer: NodeJS.Timeout;
  private subscriptions: vscode.Disposable[] = [];
  private output = vscode.window.createOutputChannel('tgrep Search');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  private refreshStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 29);
  readonly initialized: Promise<void>;

  constructor(private context: vscode.ExtensionContext) {
    this.status.command = 'tgrepSearch.open';
    this.status.name = t("tgrep: index status");
    this.status.text = t("$(search) tgrep: setup");
    this.status.show();
    this.refreshStatus.text = '$(refresh)';
    this.refreshStatus.name = t("tgrep: update index");
    this.refreshStatus.tooltip = t("tgrep: build / update index");
    this.refreshStatus.command = 'tgrepSearch.rebuild';
    this.refreshStatus.show();
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.initialized = this.initialize();
    this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.initialize()));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('tgrepSearch.language')) {
        configureLanguage();
        this.status.name = t('tgrep: index status');
        this.refreshStatus.name = t('tgrep: update index');
        this.refreshStatus.tooltip = t('tgrep: build / update index');
        if (this.view) this.renderHtml(this.view);
      }
      if (event.affectsConfiguration('tgrepSearch')) { this.cancelSearch(); void this.refresh(); }
    }));
  }

  private scopeKey(): string { return 'selection:' + JSON.stringify((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.toString()).sort()); }
  private config() { return vscode.workspace.getConfiguration('tgrepSearch', this.binding ? vscode.Uri.file(this.binding.root) : undefined); }
  private async initialize(): Promise<void> {
    const selected = this.context.workspaceState.get<string>(this.scopeKey());
    const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    const root = selected ?? active?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      try { await this.setRoot(root, false); }
      catch (error) {
        // A moved/deleted saved folder must not permanently reject initialized:
        // the folder picker still needs to work so the user can recover.
        this.cancelSearch();
        this.binding = this.bindingForRoot(root);
        this.state = { ...this.binding, state: 'error', detail: t('Folder unavailable: {0}', String(error)), time: null, timeKind: 'unknown' };
        this.renderState();
      }
    }
    else { this.cancelSearch(); this.binding = undefined; this.state = undefined; this.renderState(); }
  }
  private bindingForRoot(root: string): Binding {
    const bindings = this.context.workspaceState.get<Record<string, string>>('bindings', {});
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 24);
    return { root, index: bindings[root] ?? path.join(this.context.globalStorageUri.fsPath, 'indexes', hash) };
  }
  private async runtime(): Promise<Runtime> {
    let executable = expand(this.config().get<string>('executable', 'tgrep'));
    if (executable === 'tgrep') {
      // GUI-launched VS Code may not inherit the interactive shell PATH.
      const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
      paths.push(path.join(os.homedir(), '.local', 'bin'));
      for (const dir of paths) {
        const candidate = path.join(dir, 'tgrep');
        try { await fs.access(candidate, fs.constants.X_OK); executable = candidate; break; } catch { /* try next */ }
      }
    }
    return { executable, python: expand(this.config().get<string>('pythonExecutable', 'python3')), script: this.context.asAbsolutePath('scripts/guard.py'), externalLock: expand(this.config().get<string>('externalLockPath', '')) };
  }
  private async setRoot(root: string, save = true): Promise<void> {
    if (this.building) throw new Error(t("Wait for the build to finish or cancel it."));
    const canonical = await fs.realpath(root);
    this.cancelSearch();
    this.checkJob?.cancel();
    this.binding = this.bindingForRoot(canonical);
    this.state = undefined;
    if (save) await this.context.workspaceState.update(this.scopeKey(), canonical);
    this.renderState();
    await this.refresh();
  }
  private async saveIndex(index: string): Promise<void> {
    if (!this.binding || this.building) return;
    const canonical = await fs.realpath(index);
    if (contained(this.binding.root, canonical)) throw new Error(t("The index folder must be outside the source folder."));
    this.cancelSearch();
    this.checkJob?.cancel();
    const bindings = this.context.workspaceState.get<Record<string, string>>('bindings', {});
    bindings[this.binding.root] = canonical;
    await this.context.workspaceState.update('bindings', bindings);
    this.binding = { root: this.binding.root, index: canonical };
    this.state = undefined;
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.checking || this.building || !this.binding) return;
    this.checking = true;
    const binding = this.binding;
    try {
      const runtime = await this.runtime();
      if (this.building || this.disposed || binding !== this.binding) return;
      const check = inspectIndex(runtime, binding);
      this.checkJob = check.job;
      const state = await check.result;
      if (binding === this.binding && !this.disposed) {
        if ((state.state === 'busy' || state.state === 'error') && !state.time && this.state?.time) {
          state.time = this.state.time; state.timeKind = this.state.timeKind; state.timeLastKnown = true;
        }
        this.state = state;
      }
    } catch (error) {
      if (binding === this.binding && !this.disposed) this.state = { ...binding, state: 'error', detail: String(error), time: null, timeKind: 'unknown' };
    } finally {
      this.checking = false;
      this.checkJob = undefined;
      if (!this.disposed) this.renderState();
    }
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    this.renderHtml(view);
    this.subscriptions.push(view.webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => this.error(error)); }));
    this.subscriptions.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
  }
  private renderHtml(view: vscode.WebviewView): void {
    const nonce = randomBytes(18).toString('hex');
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    void fs.readFile(this.context.asAbsolutePath('media/panel.html'), 'utf8').then(html => {
      if (this.view !== view) return;
      view.webview.html = html.replace('{{language}}', getLanguage()).replace('{{localization}}', () => JSON.stringify({ language: getLanguage(), messages: getMessages() }).replaceAll('<', '\\u003c')).replaceAll('{{csp}}', view.webview.cspSource).replaceAll('{{nonce}}', nonce).replace('{{style}}', asset('panel.css')).replace('{{script}}', asset('panel.js'));
    });
  }
  private post(message: object): void { void this.view?.webview.postMessage(message); }
  private renderState(): void {
    const detail = this.building ? t("Building index…") : this.state?.detail ?? t("Choose a source folder");
    const time = this.state ? timeLabel(this.state) : t("unknown");
    this.post({ type: 'state', binding: this.binding, detail, state: this.building ? 'building' : this.state?.state ?? 'missing', time, indexedAt: this.state?.time, timeKind: this.state?.timeKind, building: this.building });
    const label = this.building ? t("$(sync~spin) tgrep: building") : this.state?.state === 'ready' ? t("$(database) tgrep: index ready") : this.state?.state === 'busy' ? t("$(sync~spin) tgrep: busy") : t("$(warning) tgrep: no ready index");
    this.status.text = label + (this.state?.time && !this.building ? ' · ' + (this.state.timeKind === 'completed' ? '' : '≈') + new Date(this.state.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    this.status.tooltip = t('{0}\nIndex: {1}\n{2}\nLast successful update: {3}', this.binding?.root ?? t('No folder selected'), this.binding?.index ?? t('not selected'), detail, time);
  }
  private renderResults(): void {
    this.post({ type: 'results', root: this.binding?.root, matches: this.matches, message: this.resultMessage, searching: this.searching, mode: this.lastQuery?.mode ?? 'content' });
  }
  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    this.post({ type: 'error', message });
    void vscode.window.showErrorMessage('tgrep: ' + message);
  }
  async open(selection?: string): Promise<void> {
    await this.initialized;
    if (selection !== undefined) this.pendingQuery = selection;
    await vscode.commands.executeCommand('tgrepSearch.panel.focus');
    this.view?.show?.(true);
    this.post({ type: 'focus', query: this.pendingQuery });
    if (selection !== undefined) {
      const query: Query = { query: selection, regex: false, caseSensitive: true, glob: '', mode: 'content' };
      await this.startSearch(query);
    }
  }
  private async handle(message: any): Promise<void> {
    if (!message || typeof message.type !== 'string') return;
    await this.initialized;
    switch (message.type) {
      case 'ready':
        this.renderState(); this.renderResults();
        if (this.pendingQuery !== undefined) this.post({ type: 'focus', query: this.pendingQuery });
        break;
      case 'source': {
        if (this.building) return;
        const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: t("Source folder"), defaultUri: this.binding && vscode.Uri.file(this.binding.root) });
        if (chosen?.[0]) await this.setRoot(chosen[0].fsPath);
        break;
      }
      case 'project': {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const chosen = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: t("Active tgrep project (multi-root)") });
        if (chosen) await this.setRoot(chosen.folder.uri.fsPath);
        break;
      }
      case 'index': {
        if (!this.binding || this.building) return;
        const chosen = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: t("Index folder") });
        if (chosen?.[0]) await this.saveIndex(chosen[0].fsPath);
        break;
      }
      case 'refresh': await this.refresh(); break;
      case 'build': await this.rebuild(); break;
      case 'cancelBuild': this.buildJob?.cancel(); break;
      case 'cancel': this.cancelSearch(); break;
      case 'log': this.output.show(true); break;
      case 'search': {
        if (typeof message.query !== 'string' || message.query.length > 16384 || typeof message.glob !== 'string' || message.glob.length > 4096) throw new Error(t("Invalid query"));
        this.pendingQuery = undefined;
        await this.startSearch({ query: message.query, glob: message.glob, regex: message.regex === true, caseSensitive: message.caseSensitive === true, mode: message.mode === 'files' ? 'files' : 'content' });
        break;
      }
      case 'open': {
        if (!Number.isSafeInteger(message.id)) return;
        const match = this.matches[message.id];
        if (!match || !this.binding) return;
        const canonical = await fs.realpath(match.path);
        if (!contained(this.binding.root, canonical)) throw new Error(t("The file is outside the source folder"));
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(canonical));
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        const line = Math.min(match.line, document.lineCount - 1);
        const span = match.spans[0] ?? { start: 0, end: 0 };
        const selection = document.validateRange(new vscode.Range(line, span.start, line, span.end));
        editor.selection = new vscode.Selection(selection.start, selection.end);
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        if (match.text && document.lineAt(line).text !== match.text) void vscode.window.showInformationMessage(t("tgrep: this line has changed since the search. Search again and rebuild the index if needed."));
        break;
      }
    }
  }
  private cancelSearch(): void {
    this.generation.next();
    this.searchJob?.cancel(); this.searchJob = undefined;
    this.searching = false; this.matches = [];
    this.resultMessage = t("Search stopped. Enter a query and press Enter.");
    this.renderResults();
  }
  private async startSearch(query: Query): Promise<void> {
    this.cancelSearch();
    const id = this.generation.next();
    const binding = this.binding;
    if (!binding) throw new Error(t("Choose a source folder."));
    if (this.building) throw new Error(t("The index is being built. Wait for it to finish."));
    this.searching = true; this.lastQuery = query; this.resultMessage = t("Searching…"); this.renderResults();
    try {
      const runtime = await this.runtime();
      if (!this.generation.current(id)) return;
      const maxResults = Math.max(1, Math.min(10000, this.config().get<number>('maxResults', 1000)));
      const maxBytes = Math.max(1, Math.min(32, this.config().get<number>('maxOutputMB', 8))) * 1024 * 1024;
      const operation = search(runtime, binding, query, maxResults, maxBytes);
      this.searchJob = operation.job;
      const result = await operation.result;
      if (!this.generation.current(id)) return;
      this.matches = result.matches;
      this.resultMessage = result.cancelled ? t("Search cancelled.") : t('{0} {1} · {2} s{3}', result.matches.length, query.mode === 'files' ? t('files') : t('lines'), (result.elapsedMs / 1000).toFixed(2), result.limited ? t(' · limit reached; results are incomplete') : result.matches.length === 0 ? t(' · no matches') : '');
    } catch (error) {
      if (!this.generation.current(id)) return;
      this.matches = []; this.resultMessage = error instanceof Error ? error.message : String(error);
      this.output.appendLine(this.resultMessage);
    } finally {
      if (this.generation.current(id)) { this.searching = false; this.searchJob = undefined; this.renderResults(); void this.refresh(); }
    }
  }
  async rebuild(): Promise<void> {
    await this.initialized;
    if (!this.binding) { await this.open(); return; }
    if (this.building) return;
    const previousSearch = this.searchJob;
    const previousCheck = this.checkJob;
    this.cancelSearch();
    previousCheck?.cancel();
    this.building = true; this.renderState();
    const binding = this.binding;
    this.output.appendLine(t('\nUpdating {0}\nIndex: {1}', binding.root, binding.index));
    try {
      await Promise.allSettled([previousSearch?.done, previousCheck?.done]);
      const runtime = await this.runtime();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("tgrep: updating index"), cancellable: true }, async (progress, token) => {
        const append = (value: string) => { this.output.append(value); this.post({ type: 'log', text: value.slice(-4000) }); progress.report({ message: value.trim().slice(-160) }); };
        const job = runGuard(runtime.python, runtime.script, { op: 'build', ...binding, executable: runtime.executable, externalLock: runtime.externalLock }, data => append(data.toString('utf8')), append);
        this.buildJob = job;
        const cancel = token.onCancellationRequested(() => job.cancel());
        try {
          const result = await job.done;
          if (result.cancelled) throw new Error(t("Update cancelled. The unfinished index is blocked until a successful rebuild."));
          if (result.code !== 0) throw new Error(result.stderr || t('Build exited with code {0}', result.code));
          this.output.appendLine(t("Successful completion confirmed; timestamp saved."));
        } finally { cancel.dispose(); }
      });
    } catch (error) { this.error(error); }
    finally { this.buildJob = undefined; this.building = false; await this.refresh(); this.renderState(); }
  }
  dispose(): void {
    this.disposed = true; clearInterval(this.timer);
    this.searchJob?.cancel(); this.buildJob?.cancel(); this.checkJob?.cancel();
    this.status.dispose(); this.refreshStatus.dispose(); this.output.dispose();
    this.subscriptions.forEach(item => item.dispose());
  }
}

export function activate(context: vscode.ExtensionContext): void {
  configureLanguage();
  const provider = new Panel(context);
  context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider('tgrepSearch.panel', provider));
  context.subscriptions.push(vscode.commands.registerCommand('tgrepSearch.open', () => provider.open()));
  context.subscriptions.push(vscode.commands.registerCommand('tgrepSearch.selection', () => {
    const editor = vscode.window.activeTextEditor;
    const selected = editor?.document.getText(editor.selection);
    return provider.open(selected || undefined);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('tgrepSearch.rebuild', () => provider.rebuild()));
  context.subscriptions.push(vscode.commands.registerCommand('tgrepSearch.refresh', () => provider.refresh()));
}
