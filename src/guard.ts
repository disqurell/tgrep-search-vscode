import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Binding, Job, ProcessResult, contained } from './core';
import { DIRTY, RECEIPT, canonical, exists, fingerprint, inspect, readJson, sameGeneration } from './index';
import { nativeSession, BusyError } from './native';
import { t } from './i18n';

interface Request extends Binding { op: 'status' | 'build' | 'search'; executable?: string; args?: string[]; externalLock?: string }
export function runGuard(helper: string, request: Request, onData: (chunk: Buffer) => void, onLog?: (text: string) => void): Job {
  let cancelled = false, limited = false;
  let session: ReturnType<typeof nativeSession> | undefined;
  const stopped = () => cancelled || limited;
  const outcome = (code: number | null = 130, stderr = ''): ProcessResult => ({ code, stderr, cancelled, limited });
  const done = (async (): Promise<ProcessResult> => {
    try {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error(t('This extension package supports macOS Apple Silicon only.'));
      const root = await canonical(request.root), index = await canonical(request.index);
      const binding = { root, index };
      if (!(await fs.stat(root)).isDirectory()) throw new Error(t('The source folder does not exist'));
      if (contained(root, index)) throw new Error(t('Choose an index folder outside the source folder (prevents self-indexing)'));
      if (stopped()) return outcome();
      if (request.op === 'build') await fs.mkdir(path.dirname(index), { recursive: true });
      if (!await exists(path.dirname(index))) {
        if (request.op !== 'status') throw new Error(t('Index not found. Click Build / update.'));
        onData(Buffer.from(JSON.stringify(await inspect(binding)))); return outcome(0);
      }
      const external = await canonical(request.externalLock || path.join(path.dirname(index), path.basename(index) + '-update.lock'));
      const lock = await canonical(path.join(path.dirname(index), path.basename(index) + '.tgrep-search.lock'));
      const args = request.op === 'build' ? ['index', root, '--hidden', '--exclude', '.git', '--index-path', index] : request.args ?? [];
      if (stopped()) return outcome();
      session = nativeSession(helper, [lock, external], request.op === 'build', root,
        request.op === 'status' ? [] : [request.executable!, ...args],
        data => { if (!stopped()) onData(data); }, onLog);
      await session.ready;
      if (stopped()) return outcome();
      const state = await inspect(binding);
      if (stopped()) return outcome();
      if (request.op === 'status') { onData(Buffer.from(JSON.stringify(state))); return outcome(0); }
      if (request.op === 'build') {
        if (state.state === 'mismatch') throw new Error(state.detail + t('. Choose another index folder.'));
        if (await exists(path.join(index, 'serve.json'))) throw new Error(t('Cannot rebuild an index while serve.json is present'));
        if (await exists(index) && (await fs.readdir(index)).length && !await exists(path.join(index, 'meta.json')) && !await exists(path.join(index, DIRTY))) throw new Error(t('The folder is not empty and has no tgrep metadata. Choose an empty folder.'));
        if (await exists(path.join(index, 'meta.json'))) {
          const meta = await readJson(path.join(index, 'meta.json'));
          if (typeof meta?.root_path !== 'string' || !path.isAbsolute(meta.root_path) || await canonical(meta.root_path) !== root) throw new Error(t('Cannot verify the source folder of the existing index'));
        }
        if (stopped()) return outcome();
        await fs.mkdir(index, { recursive: true });
        await fs.writeFile(path.join(index, DIRTY), JSON.stringify({ root, pid: process.pid }));
      } else if (state.state !== 'ready') throw new Error(state.detail);
      if (stopped()) return outcome();
      const result = await session.run();
      if (stopped()) return outcome(result.code, result.stderr);
      if (result.code === 127 || result.code === 126) throw new Error(t('Could not start tgrep: {0}. Check tgrepSearch.executable.', result.stderr));
      if (request.op === 'build' && result.code === 0) {
        const final = await inspect(binding, true);
        if (final.state !== 'ready') throw new Error(t('The build finished, but index validation failed: ') + final.detail);
        if (stopped()) return outcome();
        const receipt = { schema: 2, root, completedAt: new Date().toISOString(), fingerprint: final.fingerprint };
        const temp = path.join(index, RECEIPT + '.tmp');
        await fs.writeFile(temp, JSON.stringify(receipt));
        if (stopped()) return outcome();
        await fs.rename(temp, path.join(index, RECEIPT));
        await fs.unlink(path.join(index, DIRTY));
      } else if (request.op === 'search' && !sameGeneration(await fingerprint(index), state.fingerprint)) throw new Error(t('The index changed during the search. Results were discarded; search again.'));
      return outcome(result.code, result.stderr);
    } catch (error) {
      if (stopped()) return outcome();
      if (error instanceof BusyError && request.op === 'status') {
        onData(Buffer.from(JSON.stringify({ ...request, state: 'busy', detail: t('Index busy: update or another process'), time: null, timeKind: 'unknown' })));
        return outcome(0);
      }
      throw error;
    } finally { await session?.release(); }
  })();
  return { done, cancel() { cancelled = true; session?.cancel(); }, limit() { limited = true; session?.cancel(); } };
}
