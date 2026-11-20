// Fails a pull request that changes what the planboard package ships but adds no changeset.
// Shipped paths follow `files` in package.json.
//
//   node scripts/check-changeset.mjs [base]   (default: origin/main)
import { execFileSync } from "node:child_process";

const SHIPPED = [/^bin\.js$/, /^(?!.*\.test\.)[^/]+\.ts$/, /^public\//, /^prompts\//, /^hooks\//, /^examples\/workspace\//, /^docs\/configuration\.md$/, /^package\.json$/];

const base = process.argv[2] ?? "origin/main";
const lines = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);

const shipped = lines("diff", "--name-only", `${base}...HEAD`).filter((file) => SHIPPED.some((pattern) => pattern.test(file)));
const added = lines("diff", "--name-only", "--diff-filter=A", `${base}...HEAD`).filter((file) => /^\.changeset\/.+\.md$/.test(file) && !file.endsWith("README.md"));

if (!shipped.length) console.log("No shipped files changed; no changeset needed.");
else if (added.length) console.log(`Changeset found: ${added.join(", ")}`);
else {
  console.error(`These changes ship in the planboard package, but the branch adds no changeset:
${shipped.map((file) => `  ${file}`).join("\n")}

Add one with:  npm run changeset:add <patch|minor|major> "Release note"
If the change needs no release, add an empty one with:  npx @changesets/cli@2.31.1 add --empty`);
  process.exitCode = 1;
}
