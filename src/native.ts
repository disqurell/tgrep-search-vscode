import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { t } from './i18n';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A setup failure can precede a consumer awaiting the next protocol stage.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export class BusyError extends Error {
  constructor() { super(t('Index busy. Wait for the search / external update to finish.')); }
}

/** Locks stay held until release(), including after the command's stdout ends. */
export function nativeSession(helper: string, locks: string[], exclusive: boolean, cwd: string, command: string[], onData: (chunk: Buffer) => void, onLog?: (text: string) => void) {
  const child = spawn(helper, [exclusive ? 'exclusive' : 'shared', ...locks, cwd, ...command], {
    shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe']
  });
  const ready = deferred<void>(), exited = deferred<number>(), closed = deferred<void>();
  const out = deferred<void>(), err = deferred<void>();
  let stderr = '', failure: Error | undefined, protocol = '', sawReady = false, sawExit = false;
  let stopped = false;
  const cancel = () => { stopped = true; if (!child.stdin!.destroyed) child.stdin!.write('C'); };
  child.stdin!.on('error', () => { /* close owns the result */ });
  child.stdout!.on('data', (data: Buffer) => {
    if (!stopped && !failure) try { onData(data); } catch (error) { failure = error as Error; cancel(); }
  });
  child.stdout!.on('end', () => out.resolve());
  child.stderr!.on('data', (data: Buffer) => {
    const value = data.toString('utf8'); stderr = (stderr + value).slice(-32768);
    try { onLog?.(value); } catch (error) { failure = error as Error; cancel(); }
  });
  child.stderr!.on('end', () => err.resolve());
  (child.stdio[3] as Readable).on('data', (data: Buffer) => {
    protocol += data.toString('ascii');
    let at: number;
    while ((at = protocol.indexOf('\n')) >= 0) {
      const line = protocol.slice(0, at); protocol = protocol.slice(at + 1);
      if (line === 'READY' && !sawReady) { sawReady = true; ready.resolve(); }
      else if (/^EXIT \d+$/.test(line) && !sawExit && sawReady) { sawExit = true; exited.resolve(Number(line.slice(5))); }
      else { failure = new Error(t('Invalid response from the bundled index helper. Reinstall the extension.')); cancel(); }
    }
    if (protocol.length > 1024) { failure = new Error(t('Invalid response from the bundled index helper. Reinstall the extension.')); cancel(); }
  });
  child.on('error', error => { failure = new Error(t('Could not start the bundled index helper: {0}. Reinstall the extension.', error.message)); });
  child.on('close', code => {
    const error = failure ?? (code === 75 ? new BusyError() : new Error(stderr.trim() || t('Index helper exited with code {0}', code)));
    if (!sawReady) ready.reject(error);
    if (!sawExit) exited.reject(error);
    out.resolve(); err.resolve(); closed.resolve();
  });
  return {
    ready: ready.promise,
    cancel,
    async run() {
      child.stdin!.write('G');
      const [code] = await Promise.all([exited.promise, out.promise, err.promise]);
      if (failure) throw failure;
      return { code, stderr: stderr.trim() };
    },
    async release() {
      if (!child.stdin!.destroyed) child.stdin!.end('R');
      await closed.promise;
    }
  };
}
