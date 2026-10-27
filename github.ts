import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue } from "./issues.ts";

// GitHub issues for the Issues page (viewer.config.json `issues.github`), one `gh issue list` per tracked repository, in
// the same shape as Jira issues. Keys are `github:<owner>/<repo>#<number>`; `label` (`<repo>#<number>`) is what shows.

const exec = promisify(execFile);
const LIMIT = 500;
const FIELDS = "number,title,url,body,state,stateReason,labels,assignees,author,createdAt,updatedAt,comments,milestone,issueType,parent,closedByPullRequestsReferences";
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
// GitHub has no email or display name through `gh issue list`; the login stands in for both, and `login` draws the avatar.
const person = (value: any) => (value?.login ? { name: value.login, email: "", login: value.login } : null);
export const githubIssueKey = (slug: string, number: number) => `github:${slug}#${number}`;

export function slimGithubIssue(raw: any, slug: string): Issue {
  const repo = slug.split("/")[1];
  const comments = (raw.comments || []).map((comment: any) => ({ id: comment.id || comment.url, author: person(comment.author), created: comment.createdAt, body: comment.body || "" }));
  const description = raw.body || "";
  const closers = (raw.closedByPullRequestsReferences || []).map((pr: any) => pr.url).filter(Boolean);
  const closed = raw.state === "CLOSED";
  const parentNumber = raw.parent?.number;
  return {
    key: githubIssueKey(slug, raw.number), label: `${repo}#${raw.number}`, source: "github", url: raw.url, summary: raw.title || "", project: repo,
    type: raw.issueType?.name || "Issue", level: 0, status: closed ? (raw.stateReason === "NOT_PLANNED" ? "Not planned" : "Closed") : "Open", category: closed ? "done" : "new",
    priority: "", assignee: person(raw.assignees?.[0]), reporter: person(raw.author), labels: (raw.labels || []).map((label: any) => label.name), components: raw.milestone?.title ? [raw.milestone.title] : [],
    parent: parentNumber ? githubIssueKey(slug, parentNumber) : "", created: raw.createdAt, updated: raw.updatedAt,
    resolution: closed ? raw.stateReason === "NOT_PLANNED" ? "Not planned" : "Completed" : "", due: raw.milestone?.dueOn?.slice(0, 10) || "", start: "", confidence: "", statusUpdate: "",
    links: [], prCount: 0, prState: "", description, comments, attachments: 0,
    prUrls: [...new Set([...closers, ...([description, ...comments.map((comment: any) => comment.body)].join("\n").match(PR_URL) || [])])],
  };
}

// Every issue, open and closed, in each repository; a repository that fails (issues off, no access) is skipped.
export async function fetchGithub(slugs: string[], progress: (text: string) => void = () => {}) {
  const issues: Issue[] = [];
  for (const [index, slug] of slugs.entries()) {
    progress(`Reading GitHub issues: ${slug} (${index + 1} of ${slugs.length})`);
    const out = await exec("gh", ["issue", "list", "-R", slug, "--state", "all", "--limit", String(LIMIT), "--json", FIELDS], { maxBuffer: 64 << 20 }).then((result) => result.stdout, () => "[]");
    for (const raw of JSON.parse(out || "[]")) issues.push(slimGithubIssue(raw, slug));
  }
  return issues;
}

export async function githubLogin() {
  return (await exec("gh", ["api", "user", "--jq", ".login"]).then((result) => result.stdout, () => "")).trim();
}
