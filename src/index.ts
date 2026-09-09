import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Binding, IndexState } from './core';
import { t } from './i18n';

export const FILES = ['meta.json', 'index.bin', 'lookup.bin', 'files.bin', 'files-extra.bin', 'filestamps.json'];
export const DIRTY = '.tgrep-search-building.json';
export const RECEIPT = '.tgrep-search-completed.json';
type Fingerprint = Record<string, string[] | null>;
export interface InspectedIndex extends IndexState { fingerprint?: Fingerprint }
export async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Resolve symlinked ancestors even when the final directory does not exist yet. */
export async function canonical(file: string): Promise<string> {
  const absolute = path.resolve(file);
  try { const real = await fs.realpath(absolute);
    // tgrep's Rust canonicalize may emit a Windows extended-length prefix.
    if (process.platform === 'win32' && real.startsWith('\\\\?\\')) return real.startsWith('\\\\?\\UNC\\') ? '\\\\' + real.slice(8) : real.slice(4);
    return real; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonical(parent), path.basename(absolute));
  }
}
export async function fingerprint(index: string): Promise<Fingerprint> {
  return Object.fromEntries(await Promise.all(FILES.map(async name => {
    try {
      const s = await fs.stat(path.join(index, name), { bigint: true });
      return [name, [s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, null]; throw error; }
  })));
}
export async function readJson(file: string): Promise<any> {
  const handle = await fs.open(file, 'r');
  try {
    // Metadata is small. Bound reads even if an external writer replaces it.
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error(t('Index metadata exceeds 1 MiB.'));
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
function validReceipt(receipt: any, root: string): boolean {
  return receipt?.root === root && typeof receipt.completedAt === 'string' && Number.isFinite(Date.parse(receipt.completedAt));
}
export async function inspect(binding: Binding, allowDirty = false): Promise<InspectedIndex> {
  const { root, index } = binding;
  const base: IndexState = { ...binding, state: 'missing', detail: t('Index not found'), time: null, timeKind: 'unknown' };
  try {
    const dirty = await exists(path.join(index, DIRTY));
    if (!await exists(path.join(index, 'meta.json'))) {
      if (dirty) throw new Error(t('The previous build did not finish. Rebuild the index.'));
      return base;
    }
    const meta = await readJson(path.join(index, 'meta.json'));
    if (typeof meta?.root_path !== 'string' || !path.isAbsolute(meta.root_path)) throw new Error(t('Invalid root_path in meta.json'));
    if (await canonical(meta.root_path) !== root) return { ...base, state: 'mismatch', detail: t('The index belongs to another folder: ') + meta.root_path };
    let receipt: any;
    try { receipt = await readJson(path.join(index, RECEIPT)); } catch { /* old/external index */ }
    if (validReceipt(receipt, root)) Object.assign(base, { time: receipt.completedAt, timeKind: 'completed', timeLastKnown: true });
    if (meta.version !== 2) throw new Error(t('Only index format version=2 is supported (tgrep 1.0.5)'));
    if (meta.complete !== undefined && meta.complete !== true) throw new Error(t('The index is incomplete: complete=false'));
    if (dirty && !allowDirty) throw new Error(t('The previous build did not finish. Rebuild the index.'));
    if (await exists(path.join(index, 'serve.json'))) throw new Error(t('Found serve.json. Stop tgrep serve and remove its metadata before using the disk index.'));
    const fp = await fingerprint(index);
    for (const name of ['meta.json', 'index.bin', 'lookup.bin', 'files.bin']) if (!fp[name]) throw new Error(t('Missing index file: ') + name);
    const size = (name: string) => BigInt(fp[name]![1]);
    if (size('lookup.bin') % 16n || size('index.bin') % 6n) throw new Error(t('Invalid binary index file size'));
    if (Number.isSafeInteger(meta.num_trigrams) && size('lookup.bin') !== BigInt(meta.num_trigrams) * 16n) throw new Error(t('lookup.bin does not match meta.json; an external write may be in progress'));
    if (meta.num_files > 0 && size('files.bin') === 0n) throw new Error(t('files.bin is empty but the index is not'));
    if (Object.entries(fp).some(([name, stat]) => name !== 'meta.json' && stat && BigInt(stat[2]) > BigInt(fp['meta.json']![2]))) throw new Error(t('Index files are newer than the final meta.json write: incomplete external update'));
    Object.assign(base, { time: null, timeKind: 'unknown', timeLastKnown: false });
    // v2 uses decimal strings: JS numbers cannot represent nanosecond timestamps.
    // Old Python receipts remain last-known on error; healthy old generations use
    // the honest metadata estimate until rebuilt once with this version.
    if (validReceipt(receipt, root) && receipt.schema === 2 && isDeepStrictEqual(receipt.fingerprint, fp)) {
      Object.assign(base, { time: receipt.completedAt, timeKind: 'completed' });
    } else if (typeof meta.updated_at === 'number' && meta.updated_at > 0 && Number.isFinite(new Date(meta.updated_at * 1000).getTime())) {
      Object.assign(base, { time: new Date(meta.updated_at * 1000).toISOString(), timeKind: 'metadata' });
    } else {
      Object.assign(base, { time: new Date(Number(BigInt(fp['meta.json']![2]) / 1000000n)).toISOString(), timeKind: 'mtime' });
    }
    return { ...base, state: 'ready', detail: t('Index ready · {0} files', meta.num_files ?? '?'), fingerprint: fp };
  } catch (error) { return { ...base, state: 'error', detail: error instanceof Error ? error.message : String(error) }; }
}
export const sameGeneration = isDeepStrictEqual;
