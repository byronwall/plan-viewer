// A stand-in for `acli` that answers the calls the Issues page makes from fixtures/jira/issues.json, for tests and the demo.
// Scope is each fixture's `inScope`; `parent in (…)` and `key in (…)` filter; a query with `updated >=` finds nothing new.
import { readFileSync } from "node:fs";

const issues = JSON.parse(readFileSync(new URL("./issues.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (args[1] === "auth") console.log("✓ Authenticated\n  Site: acme.atlassian.net\n  Email: alex@acme.test");
else if (args[2] === "search") {
  const jql = flag("--jql");
  const list = (name) => jql.match(new RegExp(`${name} in \\(([^)]*)\\)`))?.[1].split(",");
  const found = /updated >=/.test(jql) ? [] : list("parent") ? issues.filter((issue) => list("parent").includes(issue.fields.parent?.key)) : list("key") ? issues.filter((issue) => list("key").includes(issue.key)) : issues.filter((issue) => issue.inScope);
  console.log(JSON.stringify(found.map(({ key }) => ({ key }))));
} else if (args[2] === "view") {
  const issue = issues.find((candidate) => candidate.key === args[3]);
  if (!issue) { console.error(`Work item ${args[3]} not found`); process.exit(1); }
  console.log(JSON.stringify({ key: issue.key, fields: issue.fields }));
} else { console.error(`fake-acli: unsupported ${args.join(" ")}`); process.exit(1); }
