// Every page the client can show must be routed through the one VIEWS table in public/app.js, so boot, Back/Forward
// and live refreshes all know it. A page missing from a hand-written chain used to fall through to the daily plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const table = source.slice(source.indexOf("const VIEWS = "), source.indexOf("\n});", source.indexOf("const VIEWS = ")));
const registered = new Set([...table.matchAll(/^ {2}(\w+): \{/gm)].map((match) => match[1]));
const libraryBlock = source.slice(source.indexOf("const LIBRARY_VIEWS = {"), source.indexOf("\n};", source.indexOf("const LIBRARY_VIEWS = {")));
const libraryViews = [...libraryBlock.matchAll(/^ {2}(\w+): \{/gm)].map((match) => match[1]);

test("every page that sets state.view is registered in VIEWS", () => {
  assert.ok(table.includes("Object.keys(LIBRARY_VIEWS)"), "the library pages are registered from LIBRARY_VIEWS");
  assert.ok(libraryViews.length > 0);
  const views = new Set([...source.matchAll(/state\.view = "(\w+)"/g)].map((match) => match[1]));
  views.delete("document");
  assert.ok(views.size > 5, "found the pages");
  for (const view of views) assert.ok(registered.has(view), `${view} sets state.view but is missing from VIEWS`);
});

test("boot, Back/Forward and the live refresh route pages only through VIEWS", () => {
  for (const view of [...registered, ...libraryViews]) {
    assert.doesNotMatch(source, new RegExp(`requestedView === "${view}"`), `boot special-cases ${view}`);
    assert.doesNotMatch(source, new RegExp(`params\\.get\\("view"\\) === "${view}"\\) \\{`), `popstate special-cases ${view}`);
  }
  const refresh = source.slice(source.indexOf("async function refreshFromMarkdown"), source.indexOf("const taskChanged", source.indexOf("async function refreshFromMarkdown")));
  assert.match(refresh, /if \(state\.view !== "document"\) \{[^}]*VIEWS\[state\.view\]/);
});
