import * as path from 'node:path';
import { t } from './i18n';

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'alpine-arm64', 'alpine-x64', 'win32-arm64', 'win32-x64'] as const;
export function platformTarget(platform = process.platform, arch = process.arch, musl?: boolean): string {
  if (platform === 'linux' && musl === undefined) {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    musl = !header?.glibcVersionRuntime;
  }
  const target = `${platform === 'linux' && musl ? 'alpine' : platform}-${arch}`;
  if (!(TARGETS as readonly string[]).includes(target)) throw new Error(t('Unsupported platform: {0}', target));
  return target;
}
export function helperRelativePath(target = platformTarget()): string {
  return path.join('dist', 'native', target, target.startsWith('win32-') ? 'guard.exe' : 'guard');
}
