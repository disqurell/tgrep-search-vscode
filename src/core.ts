import { t, getLanguage } from './i18n';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface Match { path: string; line: number; text: string; spans: { start: number; end: number }[] }
export interface Query { query: string; regex: boolean; caseSensitive: boolean; glob: string; mode: 'content' | 'files' }
export interface Binding { root: string; index: string }
export interface IndexState extends Binding { state: 'missing' | 'ready' | 'busy' | 'error' | 'mismatch'; detail: string; time: string | null; timeKind: 'completed' | 'metadata' | 'mtime' | 'unknown'; timeLastKnown?: boolean }

export function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function searchArgs(binding: Binding, q: Query): string[] {
  const args = ['--index-path', binding.index, '--color=never'];
  if (q.mode === 'files') {
    args.push('--files', '--null');
    if (q.query) args.push(`${q.caseSensitive ? '--glob' : '--iglob'}=${q.query}`);
  } else {
    if (!q.query || /[\r\n\0]/.test(q.query)) throw new Error(t("Enter a nonempty single-line query. Multiline search is not supported yet."));
    args.push('--json', '--line-buffered', q.caseSensitive ? '--case-sensitive' : '--ignore-case');
    if (!q.regex) args.push('--fixed-strings');
    // Equals keeps leading '-' unambiguously inside the option value.
    args.push(`--regexp=${q.query}`);
  }
  if (q.glob) args.push(`--glob=${q.glob}`);
  args.push('--', binding.root);
  return args;
}

function textField(value: unknown): string {
  if (value && typeof value === 'object') {
    const field = value as { text?: unknown; bytes?: unknown };
    if (typeof field.text === 'string') return field.text;
    if (typeof field.bytes === 'string') return Buffer.from(field.bytes, 'base64').toString('utf8');
  }
  throw new Error(t("Invalid text field in tgrep JSON"));
}

export function parseMatch(line: string, root: string): Match | undefined {
  const event = JSON.parse(line);
  if (['begin', 'end', 'summary', 'context'].includes(event.type)) return;
  if (event.type !== 'match') throw new Error(t("Unknown tgrep JSON event type"));
  const data = event.data;
  const file = path.resolve(root, textField(data.path));
  if (!contained(root, file)) throw new Error(t("A result is outside the selected folder"));
  if (!Number.isSafeInteger(data.line_number) || data.line_number < 1 || !Array.isArray(data.submatches)) throw new Error(t("Invalid line in tgrep JSON"));
  const text = textField(data.lines).replace(/\r?\n$/, '');
  const bytes = Buffer.from(text, 'utf8');
  const spans = data.submatches.map((span: { start: number; end: number }) => {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < span.start || span.end > bytes.length) throw new Error(t("Invalid offsets in tgrep JSON"));
    for (const offset of [span.start, span.end]) {
      if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error(t("An offset falls inside a UTF-8 character"));
    }
    return { start: bytes.subarray(0, span.start).toString('utf8').length, end: bytes.subarray(0, span.end).toString('utf8').length };
  });
  return { path: file, line: data.line_number - 1, text, spans };
}

export class Records {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(private delimiter: string, private accept: (record: string) => void, private maxRecord = 1024 * 1024) {}
  write(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }
  end(): void { this.consume(this.decoder.end()); if (this.pending) this.accept(this.pending); this.pending = ''; }
  private consume(text: string): void {
    this.pending += text;
    let at: number;
    while ((at = this.pending.indexOf(this.delimiter)) >= 0) {
      const record = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + this.delimiter.length);
      if (record.length > this.maxRecord) throw new Error(t("One output record exceeds 1 MiB. Refine your query."));
      if (record) this.accept(record);
    }
    if (this.pending.length > this.maxRecord) throw new Error(t("One output record exceeds 1 MiB. Refine your query."));
  }
}

export interface ProcessResult { code: number | null; stderr: string; cancelled: boolean; limited: boolean }
export interface Job { done: Promise<ProcessResult>; cancel(): void; limit(): void }
export function runGuard(python: string, script: string, request: object, onData: (chunk: Buffer) => void, onLog?: (text: string) => void): Job {
  const child = spawn(python, [script], { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let cancelled = false, limited = false, stderr = '', failure: Error | undefined, timer: NodeJS.Timeout | undefined;
  const signal = (sig: NodeJS.Signals) => {
    try { if (child.pid) process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch { /* already exited */ }
  };
  const stop = () => { signal('SIGTERM'); timer ??= setTimeout(() => signal('SIGKILL'), 2000); timer.unref(); };
  const done = new Promise<ProcessResult>((resolve, reject) => {
    child.on('error', error => { failure = new Error(t('Could not start {0}: {1}. Check tgrepSearch.pythonExecutable.', python, error.message)); });
    child.stdin.on('error', () => { /* process error/close owns the outcome */ });
    child.stdout.on('data', (data: Buffer) => { if (!cancelled && !limited && !failure) { try { onData(data); } catch (error) { failure = error as Error; stop(); } } });
    child.stderr.on('data', (data: Buffer) => { const value = data.toString('utf8'); stderr = (stderr + value).slice(-32768); onLog?.(value); });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (failure) reject(failure); else resolve({ code, stderr: stderr.trim(), cancelled, limited });
    });
    child.stdin.write(JSON.stringify({ language: getLanguage(), ...request }) + '\n');
  });
  return { done, cancel() { cancelled = true; stop(); }, limit() { limited = true; stop(); } };
}

export class Generation {
  private value = 0;
  next(): number { return ++this.value; }
  current(id: number): boolean { return id === this.value; }
}

export function timeLabel(state: IndexState): string {
  if (!state.time) return t("unknown");
  const date = new Date(state.time);
  if (!Number.isFinite(date.getTime())) return t("unknown");
  const suffix = state.timeKind === 'completed' ? t("confirmed by the extension") : state.timeKind === 'metadata' ? t("meta.updated_at; estimated external build completion") : t("estimated from meta.json mtime");
  return `${date.toLocaleString(getLanguage())} (${suffix}${state.timeLastKnown ? t("; last known") : ""})`;
}
