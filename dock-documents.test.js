import assert from 'node:assert/strict';
import test from 'node:test';
import { browseDocuments, documentFolder } from './public/dock.js';

const doc = (path, modified, title = path.split('/').at(-1)) => ({ path: `tasks/TASK-0101/${path}`, title, modified, created: modified });
const subs = [
  doc('decision.md', 50, 'Expiry decision'),
  doc('notes/call.md', 10),
  doc('checks/expiry/summary.md', 40),
  doc('checks/expiry/replay.txt', 30),
  doc('checks/mailer/summary.md', 60),
  doc('checks/run.txt', 20),
];
const paths = (files) => files.map((file) => file.path.replace('tasks/TASK-0101/', ''));

test('documentFolder is the folder inside the task folder', () => {
  assert.equal(documentFolder('tasks/TASK-0101/decision.md'), '');
  assert.equal(documentFolder('tasks/TASK-0101/checks/expiry/summary.md'), 'checks/expiry');
});

test('the task folder lists its own files and its subfolders, newest edit first', () => {
  const { folders, files, total } = browseDocuments(subs);
  assert.deepEqual(paths(files), ['decision.md']);
  assert.deepEqual(folders, [
    { name: 'checks', path: 'checks', count: 4, latest: 60, folders: 2 },
    { name: 'notes', path: 'notes', count: 1, latest: 10, folders: 0 },
  ]);
  assert.equal(total, 6);
});

test('a subfolder lists its files and folders; Subfolders lists everything below it', () => {
  const inside = browseDocuments(subs, { folder: 'checks' });
  assert.deepEqual(paths(inside.files), ['checks/run.txt']);
  assert.deepEqual(inside.folders.map((folder) => folder.path), ['checks/mailer', 'checks/expiry']);
  const nested = browseDocuments(subs, { folder: 'checks', nested: true });
  assert.deepEqual(paths(nested.files), ['checks/mailer/summary.md', 'checks/expiry/summary.md', 'checks/expiry/replay.txt', 'checks/run.txt']);
  assert.deepEqual(nested.folders, []);
  assert.equal(browseDocuments(subs, { folder: 'check' }).total, 0, 'a folder name prefix is not the folder');
});

test('a filter searches paths and titles below the folder', () => {
  assert.deepEqual(paths(browseDocuments(subs, { filter: 'summary' }).files), ['checks/mailer/summary.md', 'checks/expiry/summary.md']);
  assert.deepEqual(paths(browseDocuments(subs, { filter: 'expiry SUMMARY' }).files), ['checks/expiry/summary.md']);
  assert.deepEqual(paths(browseDocuments(subs, { filter: 'expiry decision' }).files), ['decision.md'], 'titles match too');
  assert.deepEqual(paths(browseDocuments(subs, { folder: 'notes', filter: 'summary' }).files), []);
});

test('Name sorts folders by name, with numbers in order', () => {
  const runs = [doc('runs/2350/a.md', 1), doc('runs/990/a.md', 2), doc('runs/2349/a.md', 3)];
  assert.deepEqual(browseDocuments(runs, { folder: 'runs', sort: 'name' }).folders.map((folder) => folder.name), ['990', '2349', '2350']);
});
