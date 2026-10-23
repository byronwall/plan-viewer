import { documentHref, escapeHtml, markdownHeadingId } from './markdown.js';
import { GLYPHS } from './icons.js';

// This small Markdown contract is shared by the server and the browser.
export function parseActions(markdown, sourcePath) {
  const actions = [];
  const sections = [];
  let section = null, fence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) fence = !fence;
    const heading = !fence && line.match(/^###\s+(.+)$/);
    if (heading) { section = { title: heading[1].trim(), lines: [] }; sections.push(section); }
    else if (section) section.lines.push(line);
  }
  for (const section of sections) {
    const body = section.lines.join('\n');
    const prompt = body.match(/^```prompt\s*\n([\s\S]*?)^```\s*$/m)?.[1]?.trim();
    if (!prompt) continue;
    actions.push({ id: `action-${actions.length + 1}`, title: section.title, prompt, sourcePath, workItem: body.match(/^Work item:\s*(\S+)/m)?.[1] || '' });
  }
  if (!actions.length) {
    // Old task bullets remain useful without rewriting their source.
    for (const match of markdown.matchAll(/^[-*]\s+(.+)((?:\n[ \t]+[^\n]+)*)/gm)) {
      const prompt = `${match[1]}${match[2]}`.trim();
      actions.push({ id: `action-${actions.length + 1}`, title: match[1].replace(/[*`]/g, ''), prompt, sourcePath, workItem: '' });
    }
  }
  return actions;
}

export function parseWorkBreakdown(markdown) {
  const nodes = [], stack = [], warnings = [];
  const invalidIds = new Set();
  const allowedStatuses = 'open, active, waiting, deferred, completed';
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^(\s*)-\s+([\w.-]+):\s+(.+?)\s+\[(open|active|waiting|deferred|completed)\](?:\s+\(after:\s*([^)]*)\))?\s*$/);
    if (!match) {
      const id = line.match(/^\s*-\s+([\w.-]+):/)?.[1];
      if (id) {
        invalidIds.add(id);
        const status = line.match(/\[([^\]]*)\](?:\s+\(after:.*\))?\s*$/)?.[1];
        const reason = status != null && !allowedStatuses.split(', ').includes(status)
          ? `Unsupported status [${status}]. ${status === 'done' ? 'Replace [done] with [completed].' : `Use one of: ${allowedStatuses}.`}`
          : 'Expected "- ID: Title [status]" with an optional "(after: ID, ID)" suffix. Include a title and a supported status.';
        warnings.push(`${id}: ${reason} Source: ${line.trim()}`);
      }
      continue;
    }
    const [, space, id, title, status, after = ''] = match;
    if (nodes.some(node => node.id === id)) { warnings.push(`Duplicate work item ${id}. Give each item a unique ID and update any references to the renamed item.`); continue; }
    const indent = space.length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const node = { id, title, status, deps: after.split(',').map(s => s.trim()).filter(Boolean), parent: stack.at(-1)?.id || '', indent };
    nodes.push(node); stack.push(node);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set(), levels = new Map(), cyclic = new Set();
  function level(id) {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) { cyclic.add(id); return 0; }
    visiting.add(id);
    const node = byId.get(id);
    let result = 0;
    for (const dep of node.deps) {
      if (!byId.has(dep)) {
        warnings.push(invalidIds.has(dep)
          ? `${id} depends on ${dep}, which could not be parsed. Fix ${dep}'s syntax above so this prerequisite can be resolved.`
          : `${id} depends on missing work item ${dep}. Correct the ID in its (after: ...) list or add the missing item; remove the dependency only if it is no longer required.`);
        continue;
      }
      result = Math.max(result, level(dep) + 1);
    }
    visiting.delete(id); levels.set(id, result); return result;
  }
  nodes.forEach(node => level(node.id));
  if (cyclic.size) warnings.push(`Dependency cycle involving ${[...cyclic].join(', ')}: an item ultimately depends on itself. Review the (after: ...) links and correct the circular prerequisite before starting dependent work.`);
  for (const node of nodes) {
    node.level = levels.get(node.id);
    node.ready = ['open', 'active'].includes(node.status) && !warnings.length && node.deps.every(id => byId.get(id)?.status === 'completed');
  }
  return { nodes, warnings };
}

// An active task whose next actions are all blocked has lost its next step. Returns why, or ''.
export function stalledTaskReason(status, actions, work) {
  if (status !== 'active' || work.warnings.length) return '';
  const byId = new Map(work.nodes.map(node => [node.id, node]));
  const remaining = work.nodes.some(node => ['open', 'active'].includes(node.status));
  if (!actions.length) return remaining ? 'Active task has open work but no next actions. Add a prompt for the next ready work item.' : '';
  const blocked = actions.map(action => ({ action, node: byId.get(action.workItem) })).filter(({ action, node }) => action.workItem && node && !node.ready);
  if (blocked.length < actions.length) return '';
  const why = blocked.map(({ action, node }) => {
    const waiting = node.deps.filter(id => byId.get(id)?.status !== 'completed');
    return `“${action.title}” (${node.id} is ${node.status}${waiting.length ? `, after ${waiting.join(', ')}` : ''})`;
  });
  return `Active task has no ready next action: ${why.join('; ')}. Add an action for work that can proceed now, such as preparation, or change the task status.`;
}

function actionPreview(action) {
  const text = action.prompt.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  return text.startsWith(action.title.replace(/\s+/g, ' ').trim()) ? '' : text;
}

const icon = glyph => `<svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[glyph]}</svg>`;

// Every action opens its draft, including waiting ones: the lock and "After …" only advise.
function actionRow(action, index, key) {
  const preview = actionPreview(action);
  const waiting = action.blocked ? `<span class="action-waiting">${escapeHtml(action.blockedReason || 'Waiting on prerequisites')}</span>` : '';
  const note = waiting || preview ? `<span class="action-note">${waiting}${waiting && preview ? ' · ' : ''}${escapeHtml(preview)}</span>` : '';
  const status = action.blocked ? 'Waiting' : 'Ready';
  return `<div class="action-row" id="${escapeHtml(markdownHeadingId(action.title))}"><button class="action-card${action.blocked ? ' is-waiting' : ''}" type="button" data-action-key="${escapeHtml(key)}" data-action-index="${index}" aria-label="Draft action: ${escapeHtml(action.title)}${action.blocked ? ` (${escapeHtml(action.blockedReason || 'waiting')})` : ''}" aria-haspopup="dialog" aria-controls="handoff-popover" aria-expanded="false"><span class="action-label">${escapeHtml(action.workItem)}</span><span class="action-status is-${status.toLowerCase()}">${icon(action.blocked ? 'lock' : 'circle-check')}</span><span class="action-text"><span class="action-title">${escapeHtml(action.title)}</span>${note}</span><span class="action-go">${icon('pen-line')}Draft</span></button></div>`;
}

// The label column fits the longest ID in the list (task numbers are four digits), so deep IDs never crowd their icon.
const labelWidth = labels => `--label-chars:${Math.max(4, ...labels.map(label => label.length))}`;

export function renderActions(actions, key) {
  if (!actions.length) return '<p class="action-empty">No next actions recorded yet.</p>';
  const width = labelWidth(actions.map(action => action.workItem || ''));
  if (!actions.some(action => action.taskTitle)) return `<div class="action-list" style="${width}">${actions.map((action, index) => actionRow(action, index, key)).join('')}</div>`;
  const groups = new Map();
  actions.forEach((action, index) => {
    const groupKey = action.taskTitle ? action.sourcePath : 'day';
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ action, index });
  });
  // The day shows each task's next ready action; the full list lives on the task page.
  return [...groups.values()].map(group => {
    const first = group.find(item => !item.action.blocked) || group[0];
    const { taskTitle, sourcePath } = first.action;
    if (!taskTitle) return `<section class="daily-action-group" style="${width}"><h3 class="daily-action-task"><span class="daily-action-day">${icon('calendar')}</span><span>Day-specific steps</span></h3>${group.map(item => actionRow(item.action, item.index, key)).join('')}</section>`;
    const [id, ...rest] = taskTitle.split(' · ');
    const href = documentHref(sourcePath, 'next-actions');
    const link = (cls, body) => `<a class="markdown-document-link ${cls}" href="${escapeHtml(href)}" data-document-path="${escapeHtml(sourcePath)}" data-document-anchor="next-actions">${body}</a>`;
    const more = group.length - 1;
    return `<section class="daily-action-group" style="${width}"><header class="daily-action-task">${link('daily-action-task-link', `${escapeHtml(id)} · ${escapeHtml(rest.join(' · '))}`)}${more ? link('daily-action-more', `+${more} more`) : ''}</header>${actionRow(first.action, first.index, key)}</section>`;
  }).join('');
}

const STATUS_ICONS = { Open: 'circle', Active: 'circle-dot', Ready: 'circle-check', Blocked: 'lock', Waiting: 'clock', Deferred: 'pause', Completed: 'check' };

// Leaves read as Ready or Blocked from their prerequisites; parents and settled items keep their recorded status.
export function workStatusLabel(n, nodes) {
  const leaf = !nodes.some(child => child.parent === n.id);
  return n.ready && leaf ? 'Ready' : ['open', 'active'].includes(n.status) && !n.ready && leaf ? 'Blocked' : n.status[0].toUpperCase() + n.status.slice(1);
}

export function workStatusIcon(n, nodes, suffix = '') {
  const label = workStatusLabel(n, nodes);
  return `<span class="work-status-icon is-${label.toLowerCase()}" title="${escapeHtml(label + suffix)}">${icon(STATUS_ICONS[label])}<span class="sr-only">${escapeHtml(label + suffix)}</span></span>`;
}

// The icon that marks an item with updates; data-work-item opens them in the work item dialog.
const notesMark = (id, count) => `<span class="work-notes-mark" data-work-item="${escapeHtml(id)}" aria-label="${count} ${count === 1 ? 'update' : 'updates'}">${icon('message-square')}${count}</span>`;

// One control everywhere completed and deferred work hides by default (task lists, work breakdowns), so it reads and behaves the same.
export const isSettled = status => ['completed', 'deferred'].includes(status);
export const showDoneToggle = (count, attrs = '') => `<label class="show-done"><input type="checkbox" ${attrs}> Show ${count} completed or deferred</label>`;

// noteCount(id) is how many task updates name a work item; those items open the work item dialog.
export function renderWorkBreakdown(work, actions, key, repairChunkId = '', noteCount = () => 0, showDone = false) {
  const { nodes, warnings } = work;
  const diagnostics = warnings.length ? `<section class="work-validation" aria-label="Work breakdown needs repair"><strong>Work breakdown needs repair</strong><p>Readiness may be wrong until these issues are fixed in the task Markdown.</p><ul>${warnings.map(w => `<li class="work-warning">${escapeHtml(w)}</li>`).join('')}</ul>${repairChunkId ? `<button type="button" class="handoff-button" data-chunk-id="${escapeHtml(repairChunkId)}" data-repair-work aria-haspopup="dialog" aria-controls="handoff-popover" aria-expanded="false">${icon('pen-line')}Draft fix</button>` : ''}</section>` : '';
  if (!nodes.length) return `${diagnostics}${warnings.length ? '' : '<p class="action-empty">Add nested work items to this task to see its tree and dependencies.</p>'}`;
  const hasChildren = n => nodes.some(child => child.parent === n.id);
  const statusLabel = n => workStatusLabel(n, nodes);
  const actionIndex = n => actions.findIndex(a => a.workItem === n.id);
  const actionAttrs = i => `data-action-key="${escapeHtml(key)}" data-action-index="${i}" aria-haspopup="dialog" aria-controls="handoff-popover"`;
  const itemAttrs = n => `data-work-item="${escapeHtml(n.id)}" aria-haspopup="dialog" aria-controls="work-item-dialog"`;
  const statusClass = n => `is-${statusLabel(n).toLowerCase()}`;
  const depthOf = n => { let d = 0; for (let p = n.parent; p; p = nodes.find(x => x.id === p)?.parent) d++; return d; };
  function tree(parent, depth = 0) {
    return `<ul style="--work-depth:${depth}">${nodes.filter(n => n.parent === parent).map(n => {
      const i = actionIndex(n);
      const notes = noteCount(n.id);
      const body = `<code>${escapeHtml(n.id)}</code>${workStatusIcon(n, nodes, i >= 0 ? ' — Draft action' : '')}<span class="work-title">${escapeHtml(n.title)}${notes ? notesMark(n.id, notes) : ''}</span><small class="work-dependencies">${n.deps.length ? `After ${n.deps.map(id => byId.get(id)?.status === 'completed' ? `<s>${escapeHtml(id)}</s>` : escapeHtml(id)).join(', ')}` : ''}</small>${i >= 0 ? `<span class="action-go">${icon('pen-line')}Draft</span>` : ''}`;
      const plainClass = `work-row${hasChildren(n) ? ' is-parent' : ''}${n.status === 'completed' ? ' is-completed' : ''}`;
      // A row with an action drafts on click, so only its icon opens the dialog; any other row with updates opens it on click.
      const row = i >= 0
        ? `<button type="button" class="work-row is-actionable${n.ready ? '' : ' is-waiting'}" style="--work-depth:${depth}" ${actionAttrs(i)}>${body}</button>`
        : notes ? `<button type="button" class="${plainClass} has-notes" style="--work-depth:${depth}" ${itemAttrs(n)}>${body}</button>`
        : `<div class="${plainClass}" style="--work-depth:${depth}">${body}</div>`;
      return `<li${isDone(n) ? ' class="is-done"' : ''}>${row}${hasChildren(n) ? tree(n.id, depth + 1) : ''}</li>`;
    }).join('')}</ul>`;
  }
  // An item that is completed or deferred, with everything under it, is clutter: the list and graph hide it by default and the "show completed or deferred" toggle brings it back.
  const byId = new Map(nodes.map(n => [n.id, n]));
  const isUnder = (n, id) => { for (let p = n; p; p = byId.get(p.parent)) if (p.id === id) return true; return false; };
  const isDone = n => nodes.every(m => !isUnder(m, n.id) || isSettled(m.status));
  const liveNodes = nodes.filter(n => !isDone(n));
  const doneCount = nodes.length - liveNodes.length;

  // Parents are containers around their children. Siblings sit in columns by dependency depth, where a dependency anywhere
  // inside a sibling's subtree counts as a dependency on that sibling, so containers order left to right like their contents.
  const LEAF_W = 220, LEAF_H = 84, GAP_X = 32, GAP_Y = 20, PAD = 12, HEAD = 34, EDGE = 16;
  function graph(visible, variant) {
    const ids = new Set(visible.map(n => n.id));
    const kids = id => visible.filter(n => n.parent === id);
    const liftTo = (id, parent) => { let n = byId.get(id); while (n && n.parent !== parent) n = byId.get(n.parent); return n && ids.has(n.id) ? n.id : null; };
    const sizes = new Map(), offsets = new Map(), abs = new Map();
    function size(id) {
      const children = kids(id);
      if (id && !children.length) return sizes.set(id, { w: LEAF_W, h: LEAF_H }).get(id);
      const after = new Map(children.map(c => [c.id, new Set(visible.filter(n => isUnder(n, c.id)).flatMap(n => n.deps).filter(d => ids.has(d)).map(d => liftTo(d, id)).filter(d => d && d !== c.id))]));
      const levels = new Map();
      const level = (cid, seen = new Set()) => levels.get(cid) ?? (seen.has(cid) ? 0 : levels.set(cid, Math.max(0, ...[...after.get(cid)].map(d => level(d, new Set(seen).add(cid)) + 1))).get(cid));
      const pad = id ? PAD : EDGE, head = id ? HEAD : EDGE;
      let x = pad, bottom = head;
      const columns = [];
      children.forEach(c => (columns[level(c.id)] ||= []).push(c));
      for (const column of columns.filter(Boolean)) {
        let y = head, width = 0;
        for (const c of column) {
          const s = size(c.id);
          offsets.set(c.id, { x, y });
          y += s.h + GAP_Y;
          width = Math.max(width, s.w);
        }
        x += width + GAP_X;
        bottom = Math.max(bottom, y - GAP_Y);
      }
      return sizes.set(id, { w: x - GAP_X + pad, h: bottom + pad }).get(id);
    }
    const place = (id, x, y) => {
      abs.set(id, { x, y, ...sizes.get(id) });
      for (const c of kids(id)) place(c.id, x + offsets.get(c.id).x, y + offsets.get(c.id).y);
    };
    const { w: width, h: height } = size('');
    for (const c of kids('')) place(c.id, offsets.get(c.id).x, offsets.get(c.id).y);
    const marker = `arrow-${escapeHtml(key)}-${variant}`;
    const edges = visible.flatMap(n => n.deps.filter(id => abs.has(id)).map(id => {
      const a = abs.get(id), b = abs.get(n.id), mid = (a.x + a.w + b.x) / 2;
      return `<path d="M ${a.x + a.w} ${a.y + LEAF_H / 2} H ${mid} V ${b.y + LEAF_H / 2} H ${b.x}" marker-end="url(#${marker})"/>`;
    })).join('');
    const boxes = visible.map(n => {
      const p = abs.get(n.id), index = actionIndex(n);
      const style = `left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px`;
      const notes = noteCount(n.id);
      const head = `<span><code>${escapeHtml(n.id)}</code>${notes ? notesMark(n.id, notes) : ''}<small class="work-status ${statusClass(n)}">${escapeHtml(statusLabel(n))}</small></span><strong>${escapeHtml(n.title)}</strong>`;
      const completed = n.status === 'completed' ? ' is-completed' : '';
      if (kids(n.id).length) return `<div class="work-group${completed}" style="${style}" title="${escapeHtml(n.title)}"><header><code>${escapeHtml(n.id)}</code><strong>${escapeHtml(n.title)}</strong><small class="work-status ${statusClass(n)}">${escapeHtml(statusLabel(n))}</small></header></div>`;
      if (index >= 0) return `<button type="button" class="work-node is-actionable${n.ready ? ' is-ready' : ''}${completed}" style="${style}" title="${escapeHtml(n.title)}" ${actionAttrs(index)}>${head}</button>`;
      return notes ? `<button type="button" class="work-node is-actionable${completed}" style="${style}" title="${escapeHtml(n.title)}" ${itemAttrs(n)}>${head}</button>` : `<div class="work-node${completed}" style="${style}" title="${escapeHtml(n.title)}">${head}</div>`;
    }).join('');
    return `<div class="work-graph is-${variant}" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" aria-hidden="true"><defs><marker id="${marker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8"/></marker></defs>${edges}</svg>${boxes}</div>`;
  }
  return `${diagnostics}<div class="work-breakdown">${doneCount ? showDoneToggle(doneCount, `data-show-done-work${showDone ? ' checked' : ''}`) : ''}<div class="work-tree" style="--work-id-col:max(calc(3 * var(--label-char)), ${[...new Set(nodes.map(n => `${depthOf(n)}, ${n.id.length}`))].map(pair => { const [d, c] = pair.split(', '); return `calc(${d} * var(--work-indent) + ${c} * var(--label-char))`; }).join(', ')})">${tree('')}</div><details class="work-graph-disclosure" open><summary>Dependency graph <span>Prerequisite → dependent</span><button type="button" class="work-graph-expand" data-graph-expand aria-label="Expand dependency graph" title="Expand"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg></button></summary><div class="work-graph-scroll" tabindex="0" aria-label="Scrollable work dependency graph">${graph(liveNodes, 'live')}${doneCount ? graph(nodes, 'full') : ''}</div></details></div>`;
}
