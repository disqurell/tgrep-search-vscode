import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const russian: Record<string, string> = JSON.parse(readFileSync(join(__dirname, '../media/l10n.ru.json'), 'utf8'));
let language: 'en' | 'ru' = 'en';

export function setLanguage(value: string, editorLanguage = 'en'): void {
  if (value === 'auto') value = editorLanguage;
  language = /^ru(?:-|$)/i.test(value) ? 'ru' : 'en';
}
export function getLanguage(): 'en' | 'ru' { return language; }
export function getMessages(): Record<string, string> { return language === 'ru' ? russian : {}; }
export function t(message: string, ...args: unknown[]): string {
  const translated = language === 'ru' && Object.hasOwn(russian, message) ? russian[message] : message;
  return translated.replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < args.length ? String(args[Number(index)]) : placeholder);
}
