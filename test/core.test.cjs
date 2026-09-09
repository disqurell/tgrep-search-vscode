require('../dist/i18n').setLanguage('ru');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMatch, Records, searchArgs, Generation, timeLabel } = require('../dist/core');
const root = '/project with space';
function event(text, start, end) { return JSON.stringify({ type: 'match', data: { path: { text: 'x.php' }, line_number: 3, lines: { text: text + '\n' }, submatches: [{ start, end }] } }); }
test('UTF-8 byte offsets become UTF-16, including emoji before and within match', () => {
  const match = parseMatch(event('Я🙂 needle🔥', 7, 17), root);
  assert.deepEqual(match.spans, [{ start: 4, end: 12 }]);
  assert.equal(match.line, 2);
  assert.equal(match.text.slice(4, 12), 'needle🔥');
});
test('JSON stream survives UTF-8 and JSON split across chunks', () => {
  const found = [];
  const stream = new Records('\n', line => found.push(parseMatch(line, root)));
  const bytes = Buffer.from(event('Я🙂 needle🔥', 7, 17));
  for (let i = 0; i < bytes.length; i++) stream.write(bytes.subarray(i, i + 1));
  stream.end(); assert.equal(found.length, 1); assert.equal(found[0].text, 'Я🙂 needle🔥');
});
test('ignores summary; rejects malformed output, traversal and invalid UTF-8 boundaries', () => {
  assert.equal(parseMatch('{"type":"summary"}', root), undefined);
  assert.throws(() => parseMatch('bad json', root));
  assert.throws(() => parseMatch(event('Я', 1, 2), root), /UTF-8/);
  assert.throws(() => parseMatch(event('x', 0, 1).replace('x.php', '../outside'), root), /пределами/);
  assert.throws(() => new Records('\n', () => {}, 3).write(Buffer.from('1234')), /превышает/);
});
test('search is explicit content JSON, safe dash query, no --hidden or shell quoting', () => {
  const args = searchArgs({ root, index: '/index with space' }, { query: '-foo $(touch nope)', regex: false, caseSensitive: true, glob: '!**/test/**', mode: 'content' });
  assert(args.includes('--regexp=-foo $(touch nope)'));
  assert(args.includes('--json')); assert(args.includes('--fixed-strings')); assert(!args.includes('--hidden'));
  assert.deepEqual(args.slice(-2), ['--', root]);
  assert.throws(() => searchArgs({ root, index: '/i' }, { query: '\n', mode: 'content' }));
});
test('file listing is null-delimited and clearly separate from content', () => {
  const args = searchArgs({ root, index: '/i' }, { query: '**/*.php', regex: false, caseSensitive: false, glob: '', mode: 'files' });
  assert(args.includes('--files')); assert(args.includes('--null')); assert(args.includes('--iglob=**/*.php')); assert(!args.includes('--json'));
});
test('late generations cannot publish results', () => {
  const generation = new Generation(); const previous = generation.next(); const next = generation.next();
  assert(!generation.current(previous)); assert(generation.current(next));
});
test('missing timestamp is unknown; estimates are visibly labelled', () => {
  assert.equal(timeLabel({ time: null }), 'неизвестно');
  assert.match(timeLabel({ time: '2026-01-02T03:04:05Z', timeKind: 'mtime' }), /оценка по mtime/);
  assert.match(timeLabel({ time: '2026-01-02T03:04:05Z', timeKind: 'metadata' }), /оценка завершения внешней сборки/);
  assert.match(timeLabel({ time: '2026-01-02T03:04:05Z', timeKind: 'completed' }), /подтверждено/);
});
