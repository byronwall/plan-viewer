import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBrief, splitBrief } from './public/brief.js';

const store = () => { const items = new Map(); return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) }; };
const search = (brief, path = 'tasks/TASK-0001.md') => `?${new URLSearchParams({ path, brief })}`;

test('a brief in the URL opens and remembers the document it came with', () => {
  const tab = store();
  assert.deepEqual(loadBrief(search('Review the draft'), tab), { text: 'Review the draft', page: 'tasks/TASK-0001.md', dismissed: false });
  // Later navigation drops the parameter; the tab still has its brief.
  assert.equal(loadBrief('?view=issues', tab).text, 'Review the draft');
  assert.equal(loadBrief('?view=issues', store()), null);
});

test('a reload keeps a dismissed brief dismissed, and a new brief opens', () => {
  const tab = store();
  const brief = loadBrief(search('Review the draft'), tab);
  tab.setItem('plan-viewer:brief', JSON.stringify({ ...brief, dismissed: true }));
  assert.equal(loadBrief(search('Review the draft'), tab).dismissed, true);
  assert.equal(loadBrief(search('Voice over the diagram'), tab).dismissed, false);
  assert.equal(loadBrief(search('  '), tab).text, 'Voice over the diagram');
});

test('the first line is the title and the rest the body', () => {
  assert.deepEqual(splitBrief('\n## **Approve two Jira drafts**\n- Ask: approve\n- Decision: file now?\n'), { title: 'Approve two Jira drafts', body: '- Ask: approve\n- Decision: file now?' });
  assert.deepEqual(splitBrief('Just a title'), { title: 'Just a title', body: '' });
});
