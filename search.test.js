import assert from 'node:assert/strict';
import test from 'node:test';
import { contextScore, searchDocuments, searchPrs, textScore } from './public/search.js';

const documents = [
  { title: 'Daily plan', path: 'daily/2026/10/01/plan.md', kind: 'Plan' },
  { title: 'Deploy diagnostics', path: 'tasks/TASK-0021.md', kind: 'Task', task: { id: 'TASK-0021', project: 'Atlas', tags: ['Postgres'], summary: 'Find deployment errors', status: 'completed' } },
  { title: 'Atlas', path: 'reference/atlas.md', kind: 'Reference' },
];
test('search matches terms across task metadata and includes completed tasks', () => {
  assert.deepEqual(searchDocuments(documents, 'atlas POSTGRES completed'), [documents[1]]);
  assert.deepEqual(searchDocuments(documents, 'task-0021 errors'), [documents[1]]);
  assert.deepEqual(searchDocuments(documents, 'atlas missing'), []);
});
test('search ranks title matches before metadata and preserves the index', () => {
  const original = [...documents];
  assert.deepEqual(searchDocuments(documents, 'atlas'), [documents[2], documents[1]]);
  assert.deepEqual(searchDocuments(documents, '  '), documents);
  assert.deepEqual(documents, original);
  assert.deepEqual(searchDocuments(documents, '2026/10/01'), [documents[0]]);
});
test('PR search matches numbers, with an optional # or repository prefix', () => {
  const prs = [
    { slug: 'acme/atlas', number: 1938, state: 'MERGED' },
    { slug: 'acme/atlas', number: 19380, state: 'OPEN' },
    { slug: 'acme/Orbit', number: 1938, state: 'OPEN' },
    { slug: 'acme/atlas', number: 193, state: 'OPEN' },
  ];
  assert.deepEqual(searchPrs(prs, '#1938').map(pr => `${pr.slug}#${pr.number}`), ['acme/Orbit#1938', 'acme/atlas#1938', 'acme/atlas#19380']);
  assert.deepEqual(searchPrs(prs, '193').map(pr => pr.number), [193, 19380, 1938, 1938]);
  assert.deepEqual(searchPrs(prs, 'orbit#1938').map(pr => pr.number), [1938]);
  assert.deepEqual(searchPrs(prs, 'deploy 1938'), []);
});
test('PR search matches title, branch and author words, open PRs first', () => {
  const prs = [
    { slug: 'acme/atlas', number: 10, state: 'MERGED', title: 'Falcon flights', branch: 'a', author: 'x' },
    { slug: 'acme/atlas', number: 9, state: 'OPEN', title: 'Docs', branch: 'samr/falcon-ux', author: 'sam-rivera' },
    { slug: 'acme/Orbit', number: 11, state: 'OPEN', title: 'Other', branch: 'b', author: 'x' },
  ];
  assert.deepEqual(searchPrs(prs, 'falcon').map(pr => pr.number), [9, 10]);
  assert.deepEqual(searchPrs(prs, 'falcon sam').map(pr => pr.number), [9]);
  assert.deepEqual(searchPrs(prs, 'ga'), []);
});

test('ranking: title word starts beat substrings, and a recent open item beats an old finished one', () => {
  assert.equal(textScore(['delete'], 'Typo in rename'), 0);
  assert.ok(textScore(['delete'], 'Delete modal') > textScore(['delete'], 'Undeleted rows'));
  assert.equal(textScore(['mod-12'], 'Anything', '', 'MOD-12') > 60, true);
  const now = Date.parse('2026-10-23');
  const recentTask = textScore(['delete'], 'Soft delete for drafts') + contextScore({ live: true, updated: '2026-10-22', mine: true }, now);
  const oldIssue = textScore(['delete'], 'Delete modal does not look good') + contextScore({ done: true, updated: '2026-08-01' }, now);
  assert.ok(recentTask > oldIssue);
});
