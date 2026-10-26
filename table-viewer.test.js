import assert from 'node:assert/strict';
import test from 'node:test';
import { cellTest, columnKind } from './public/table-viewer.js';

const cells = (...texts) => texts.map((text) => ({ text, empty: text === '' }));

test('expanded table columns are typed from every non-empty cell', () => {
  assert.equal(columnKind(cells('1,395', '42', '', '0.5')), 'number');
  assert.equal(columnKind(cells('1.86%', '0.03%')), 'number');
  assert.equal(columnKind(cells('Sep 10', 'Aug 25', '2026-10-01')), 'date');
  assert.equal(columnKind(cells('atlas-prod', '42')), 'text');
});

test('column filters match text, exact values, exclusions and comparisons', () => {
  const cell = (text, key = text.toLowerCase()) => ({ text, key, empty: false });
  assert.equal(cellTest('start', 'text')(cell('startup only')), true);
  assert.equal(cellTest('=idle', 'text')(cell('idle time')), false);
  assert.equal(cellTest('!idle', 'text')(cell('daily')), true);
  assert.equal(cellTest('> 30', 'number')(cell('42', 42)), true);
  assert.equal(cellTest('<=1,000', 'number')(cell('1,395', 1395)), false);
  assert.equal(cellTest('>= Sep 1', 'date')(cell('Sep 10', Date.parse('Sep 10'))), true);
  assert.equal(cellTest('>', 'number'), null, 'an operator alone filters nothing yet');
  assert.equal(cellTest('  ', 'text'), null);
});
