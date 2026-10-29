const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Electron main-process source has valid JavaScript syntax', () => {
  const mainPath = path.join(__dirname, '..', 'main.js');
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(mainPath, 'utf8'), { filename: mainPath }));
});
