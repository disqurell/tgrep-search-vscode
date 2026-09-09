import { runGuard } from './guard';
import { t } from './i18n';
import * as path from 'node:path';
import { Binding, IndexState, Job, Match, Query, Records, contained, parseMatch, searchArgs } from './core';

export interface Runtime { helper: string; executable: string; externalLock: string; }
export function inspectIndex(runtime: Runtime, binding: Binding): { job: Job; result: Promise<IndexState> } {
  let output = '';
  const job = runGuard(runtime.helper, { op: 'status', ...binding, externalLock: runtime.externalLock }, chunk => {
    output += chunk.toString('utf8');
    if (output.length > 65536) throw new Error(t("The index status response is too large"));
  });
  return { job, result: job.done.then(result => {
    if (result.cancelled) throw new Error(t("Status check cancelled"));
    if (result.code !== 0) throw new Error(result.stderr || t("Could not check the index"));
    return JSON.parse(output) as IndexState;
  }) };
}

export interface SearchResult { matches: Match[]; limited: boolean; cancelled: boolean; elapsedMs: number }
export function search(runtime: Runtime, binding: Binding, query: Query, maxResults: number, maxBytes: number): { job: Job; result: Promise<SearchResult> } {
  const args = searchArgs(binding, query);
  const matches: Match[] = [];
  let bytes = 0;
  const started = Date.now();
  const records = new Records(query.mode === 'files' ? '\0' : '\n', record => {
    if (matches.length >= maxResults) return;
    let match: Match | undefined;
    if (query.mode === 'files') {
      const file = path.resolve(binding.root, record);
      if (!contained(binding.root, file)) throw new Error(t("The file is outside the selected folder"));
      match = { path: file, line: 0, text: '', spans: [] };
    } else match = parseMatch(record, binding.root);
    if (match) matches.push(match);
    if (matches.length >= maxResults) job.limit();
  });
  const job = runGuard(runtime.helper, { op: 'search', ...binding, args, executable: runtime.executable, externalLock: runtime.externalLock }, chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { job.limit(); return; }
    records.write(chunk);
  });
  return { job, result: job.done.then(result => {
    if (!result.cancelled && !result.limited) {
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || t('tgrep exited with code {0}', result.code));
      records.end();
    }
    return { matches: result.cancelled ? [] : matches, limited: result.limited, cancelled: result.cancelled, elapsedMs: Date.now() - started };
  }) };
}
