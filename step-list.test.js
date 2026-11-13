import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkBreakdown } from './public/actions.js';
import { movePill, scheduledTasks, taskStepsHtml, stepActionsHtml, stepBodyHtml, stepRowHtml, stepToggleHtml } from './public/steps-page.js';

const step = (fields) => ({ key: 'TASK-0101 W1', task: 'TASK-0101', id: 'W1', title: 'Decide the rollout', reason: 'decide', move: 'you-decide', kind: 'decision', ...fields });

test('step rows open the step dialog and never link away', () => {
  const html = stepRowHtml({ key: 'TASK-0101:W1', lead: movePill(step()), title: 'Decide the rollout', meta: 'TASK-0101 W1' });
  assert.match(html, /^<button type="button" class="step-row" data-open-step="TASK-0101:W1"><span class="step-row-lead">/);
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

test("a task's Steps group rows under workstreams, pill only what waits on you, and hide settled steps", () => {
  const work = parseWorkBreakdown([
    '- W1: Invites [open]',
    '  - W1.1: Table [completed]',
    '  - W1.2: Decide the expiry [open] (after: W1.1) {decision}',
    '  - W1.3: Send the mail [open] (after: W1.2)',
    '- W2: Ship it [open]',
  ].join('\n'));
  const steps = [step({ id: 'W1.2' }), { ...step({ id: 'W2' }), move: 'agent', reason: 'ready' }];
  const html = taskStepsHtml({ taskId: 'TASK-0101', work, steps, noteCount: (id) => id === 'W1.3' ? 2 : 0 });
  const all = html.slice(html.indexOf('data-step-layer="all"'));
  assert.match(all, /class="step-group-head" data-open-step="TASK-0101:W1"><code>W1<\/code><span>Invites/);
  assert.match(all, /class="step-row is-settled" data-open-step="TASK-0101:W1.1"/);
  assert.match(all, /data-open-step="TASK-0101:W1.2".*step-move-you[^<]*>Decide<\/span>Decide the expiry/);
  assert.match(all, /data-open-step="TASK-0101:W1.3".*2<\/span>after W1.2/);
  assert.doesNotMatch(all.slice(all.indexOf('TASK-0101:W2"')), /step-move/, 'no pill on an agent step');
  assert.match(html, /data-step-list-move="you" aria-pressed="false">You <span>1<\/span>/);
  assert.match(html, /Show 1 completed or deferred/);
  const you = html.slice(html.indexOf('data-step-layer="you"'), html.indexOf('data-step-layer="agent"'));
  assert.match(you, /TASK-0101:W1.2/);
  assert.doesNotMatch(you, /TASK-0101:W1.3/);
  assert.match(html, /data-step-layer="all">/, 'All is shown by default');
  assert.doesNotMatch(taskStepsHtml({ taskId: 'TASK-0101', work, tools: false }), /popover|data-move-default/);
});

test("a plan's scheduled tasks keep each task's note, whichever separator the plan uses", () => {
  const { rows, rest } = scheduledTasks([
    '- [TASK-0101](../../../../tasks/TASK-0101.md): merge #12, then [ask](https://example.com) about `W2`.',
    '  - and check the flag',
    '- TASK-0102 — File the issues.',
    '- [TASK-0103](../TASK-0103.md)',
    '',
    'Carry-over goes to Monday.',
  ].join('\n'));
  assert.deepEqual(rows, [
    { id: 'TASK-0101', note: 'merge #12, then ask about W2. and check the flag' },
    { id: 'TASK-0102', note: 'File the issues.' },
    { id: 'TASK-0103', note: '' },
  ]);
  assert.match(rest, /Carry-over goes to Monday/);
});
