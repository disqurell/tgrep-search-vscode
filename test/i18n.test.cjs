const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setLanguage, getLanguage, t } = require('../dist/i18n');
const translations = require('../media/l10n.ru.json');
test('English fallback, regional Russian locale, and reordered placeholders', () => {
  setLanguage('auto', 'ru-RU'); assert.equal(t('Query'), 'Запрос');
  setLanguage('en', 'ru'); assert.equal(t('Query'), 'Query');
  setLanguage('ru', 'en'); assert.equal(t('Query'), 'Запрос');
  setLanguage('en'); assert.equal(t('Query'), 'Query');
  setLanguage('ru-RU'); assert.equal(getLanguage(), 'ru'); assert.equal(t('Query'), 'Запрос');
  assert.equal(t('Line {0}: {1}', 3, '{0} needle'), 'Строка 3: {0} needle');
  setLanguage('de'); assert.equal(t('Query'), 'Query');
});
test('all extension/helper/webview literal messages have Russian translations', () => {
  for (const filename of ['src/core.ts', 'src/service.ts', 'src/extension.ts', 'src/guard.ts', 'src/index.ts', 'src/native.ts', 'media/panel.js']) {
    const source = fs.readFileSync(path.resolve(filename), 'utf8');
    for (const match of source.matchAll(/\b(?:t|tr)\((['"])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
      const key = match[2].replaceAll('\\n', '\n');
      assert(Object.hasOwn(translations, key), `${filename}: missing ${key}`);
    }
  }
  for (const [key, value] of Object.entries(translations)) {
    assert.deepEqual((key.match(/\{\d*\}/g) || []).sort(), (value.match(/\{\d*\}/g) || []).sort(), key);
  }
});
test('manifest placeholders exist in both languages', () => {
  const en = require('../package.nls.json'), ru = require('../package.nls.ru.json');
  for (const match of JSON.stringify(require('../package.json')).matchAll(/%([^%]+)%/g)) {
    assert.equal(typeof en[match[1]], 'string'); assert.equal(typeof ru[match[1]], 'string');
  }
});
