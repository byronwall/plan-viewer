import assert from 'node:assert/strict';
import test from 'node:test';
import { movePill, stepActionsHtml, stepBodyHtml, stepRowHtml, stepToggleHtml } from './public/steps-page.js';

const step = (fields) => ({ key: 'TASK-0101 W1', task: 'TASK-0101', id: 'W1', title: 'Decide the rollout', reason: 'decide', move: 'you-decide', kind: 'decision', ...fields });

test('step rows open the step dialog and never link away', () => {
  const html = stepRowHtml({ key: 'TASK-0101:W1', lead: movePill(step()), title: 'Decide the rollout', meta: 'TASK-0101 W1' });
  assert.match(html, /^<button type="button" class="step-row" data-open-step="TASK-0101:W1">/);
  assert.match(html, /step-move-you" title="decide">Decide</);
  assert.doesNotMatch(html, /href=/);
});

test('the toggle marks one segment and counts all but All', () => {
  const html = stepToggleHtml('agent', { you: 2, agent: 5, others: 0, all: 7 });
  assert.match(html, /data-step-list-move="agent" aria-pressed="true">Agent <span>5<\/span>/);
  assert.match(html, /data-step-list-move="all" aria-pressed="false">All</);
  assert.doesNotMatch(html, /All <span>/);
  assert.equal((stepToggleHtml('you', null, ['you', 'all']).match(/<button/g) || []).length, 2);
});

test("the dialog's compact actions drop the notes beside the buttons", () => {
  assert.match(stepActionsHtml(step()), /Record the decision/);
  const compact = stepActionsHtml(step(), { compact: true });
  assert.match(compact, /data-step-action="done"[^>]*>Mark decided/);
  assert.doesNotMatch(compact, /step-choice-note/);
});

test('an allow rule shows once, in the body, not again beside Apply', () => {
  const rule = step({ move: 'you-decide', kind: '', machinery: { path: 'tasks/TASK-0101-assets/allow.md', fields: { apply: 'Bash(git status)' } } });
  assert.equal((stepBodyHtml(rule) + stepActionsHtml(rule)).split('Bash(git status)').length - 1, 1);
});
