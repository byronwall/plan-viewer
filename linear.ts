import { linearKey } from "./link-metadata.ts";
import type { Issue } from "./issues.ts";

// Linear issues and projects for the Issues page (viewer.config.json `issues.linear.teams`), in the same shape as Jira
// issues so every tab, the overview and the code join treat them alike. Keys are `linear:<identifier>` because Jira
// projects can reuse a Linear team's prefix (Jira MOD-12 and Linear MOD-12 are different issues); `label` is what shows.

const API = "https://api.linear.app/graphql";
const PAGE = 40; // with descriptions, relations and 20 comments each, 50 per page passes Linear's complexity limit

const CATEGORY: Record<string, string> = { triage: "new", backlog: "new", unstarted: "new", planned: "new", started: "indeterminate", paused: "new", completed: "done", canceled: "done", duplicate: "done" };
const HEALTH: Record<string, string> = { onTrack: "🟢 On Track", atRisk: "🟡 At Risk", offTrack: "🔴 Off Track" };
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
// Linear fills `name` with the email for some accounts; the display name reads better there.
const person = (value: any) => (value ? { name: (value.name || "").includes("@") ? value.displayName || value.name : value.name || "", email: value.email || "" } : null);
export const linearIssueKey = (identifier: string) => `linear:${identifier}`;
export const linearProjectKey = (slugId: string) => `linear-project:${slugId}`;

const ISSUE_FIELDS = `identifier title url description createdAt updatedAt dueDate priorityLabel integrationSourceType
  state { name type } team { key } assignee { name displayName email } creator { name displayName email } labels { nodes { name } } project { slugId } parent { identifier }
  relations { nodes { type relatedIssue { identifier title state { name type } } } }
  attachments { nodes { sourceType url } }
  syncedWith { metadata { ... on ExternalEntityInfoJiraMetadata { issueKey } } }
  comments(first: 20) { nodes { id body createdAt user { name displayName email } } }`;
const PROJECT_FIELDS = `slugId name url state health description createdAt updatedAt startDate targetDate lead { name displayName email } creator { name displayName email }
  projectUpdates(first: 1) { nodes { body } }`;

export function slimLinearIssue(raw: any): Issue {
  const comments = (raw.comments?.nodes || []).map((comment: any) => ({ id: comment.id, author: person(comment.user), created: comment.createdAt, body: comment.body || "" }))
    .sort((a: any, b: any) => a.created.localeCompare(b.created));
  const description = raw.description || "";
  const prUrls = [...new Set([...(raw.attachments?.nodes || []).map((item: any) => item.url), description, ...comments.map((comment: any) => comment.body)].join("\n").match(PR_URL) || [])];
  const mirror = (raw.syncedWith || []).map((entry: any) => entry.metadata?.issueKey).find(Boolean);
  const type = raw.state?.type || "backlog";
  return {
    key: linearIssueKey(raw.identifier), label: raw.identifier, source: "linear", url: raw.url, summary: raw.title || "", project: raw.team?.key || raw.identifier.split("-")[0],
    type: raw.parent ? "Sub-issue" : "Issue", level: raw.parent ? -1 : 0, status: raw.state?.name || "", category: CATEGORY[type] || "new", triage: type === "triage",
    priority: raw.priorityLabel === "No priority" ? "" : raw.priorityLabel || "", assignee: person(raw.assignee), reporter: person(raw.creator),
    labels: (raw.labels?.nodes || []).map((label: any) => label.name), components: [],
    parent: raw.parent ? linearIssueKey(raw.parent.identifier) : raw.project ? linearProjectKey(raw.project.slugId) : "",
    created: raw.createdAt, updated: raw.updatedAt, resolution: type === "canceled" ? "Canceled" : type === "duplicate" ? "Duplicate" : "", due: raw.dueDate || "", start: "", confidence: "", statusUpdate: "",
    links: (raw.relations?.nodes || []).filter((relation: any) => relation.relatedIssue).map((relation: any) => ({
      type: relation.type, label: { blocks: "blocks", duplicate: "duplicates", related: "relates to", similar: "similar to" }[relation.type as string] || relation.type,
      key: linearIssueKey(relation.relatedIssue.identifier), display: relation.relatedIssue.identifier, summary: relation.relatedIssue.title, status: relation.relatedIssue.state?.name || "", category: CATEGORY[relation.relatedIssue.state?.type] || "new",
    })),
    prCount: 0, prState: "", description, comments, attachments: 0, prUrls, mirrorOf: mirror || "",
  };
}

// A Linear project reads as an epic: its lead owns it, its health is the confidence, its latest update is the status update.
export function slimLinearProject(raw: any, team: string): Issue {
  return {
    key: linearProjectKey(raw.slugId), label: "Project", source: "linear", url: raw.url, summary: raw.name || "", project: team, type: "Project", level: 1,
    status: raw.state ? raw.state[0].toUpperCase() + raw.state.slice(1) : "", category: CATEGORY[raw.state] || "new", priority: "",
    assignee: person(raw.lead), reporter: person(raw.creator), labels: [], components: [], parent: "", created: raw.createdAt, updated: raw.updatedAt,
    resolution: raw.state === "canceled" ? "Canceled" : "", due: raw.targetDate || "", start: raw.startDate || "", confidence: HEALTH[raw.health] || "",
    statusUpdate: raw.projectUpdates?.nodes?.[0]?.body || "", links: [], prCount: 0, prState: "", description: raw.description || "", comments: [], attachments: 0, prUrls: [],
  };
}

type Fetcher = (query: string, variables: Record<string, unknown>) => Promise<any>;

export function linearClient(root: string): Fetcher {
  return async (query, variables) => {
    const key = await linearKey(root);
    if (!key) throw new Error("No Linear API key in LINEAR_API_KEY or config.toml [linear] API_KEY.");
    const response = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ query, variables }) });
    const body = await response.json();
    if (body.errors?.length) throw new Error(`Linear: ${body.errors[0].userPresentableMessage || body.errors[0].message}`);
    return body.data;
  };
}

async function pages(fetcher: Fetcher, team: string, connection: "issues" | "projects", fields: string, filter: Record<string, unknown> | null, onPage: (count: number) => void) {
  const out: any[] = [];
  let after: string | null = null;
  do {
    const query = `query($team: String!, $after: String${filter ? ", $filter: IssueFilter" : ""}) { team(id: $team) { ${connection}(first: ${PAGE}, after: $after, orderBy: updatedAt${filter ? ", filter: $filter" : ""}) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } } }`;
    const data = await fetcher(query, { team, after, ...(filter ? { filter } : {}) });
    const page = data.team[connection];
    out.push(...page.nodes);
    onPage(out.length);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// Every issue and project in the teams, or with `since` (ISO time) only issues updated after it; projects are few, so
// they are always read in full.
export async function fetchLinear(fetcher: Fetcher, teams: string[], since = "", progress: (text: string) => void = () => {}) {
  const issues: Issue[] = [];
  const projects: Issue[] = [];
  for (const team of teams) {
    const filter = since ? { updatedAt: { gt: since } } : null;
    for (const raw of await pages(fetcher, team, "issues", ISSUE_FIELDS, filter, (count) => progress(`Reading Linear ${team} issues: ${count}`))) issues.push(slimLinearIssue(raw));
    for (const raw of await pages(fetcher, team, "projects", PROJECT_FIELDS, null, () => {})) projects.push(slimLinearProject(raw, team));
  }
  return { issues, projects };
}
