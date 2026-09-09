const { test } = require('node:test');
const assert = require('node:assert/strict');
const { platformTarget, helperRelativePath, TARGETS } = require('../dist/platform');
test('platform selection distinguishes CPU, OS and Linux libc', () => {
  for (const arch of ['x64', 'arm64']) {
    for (const os of ['darwin','win32']) assert.equal(platformTarget(os,arch), `${os}-${arch}`);
    assert.equal(platformTarget('linux',arch,false), `linux-${arch}`);
    assert.equal(platformTarget('linux',arch,true), `alpine-${arch}`);
  }
  for (const target of TARGETS) assert.equal(helperRelativePath(target).endsWith('.exe'), target.startsWith('win32-'));
  assert.throws(() => platformTarget('win32','ia32'), /Unsupported platform/);
});
