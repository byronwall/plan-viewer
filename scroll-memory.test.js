// Reloading or going Back must return to where the reader was, on every page, never jump to the URL's #section or
// the top. One mechanism in public/app.js owns it; these checks keep pages and history calls from bypassing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test("the app owns scroll restoration", () => {
  assert.match(source, /history\.scrollRestoration = "manual";/);
});

test("every pushState saves the spot being left, and replaceState(null) keeps it", () => {
  const wrapper = between('for (const method of ["pushState", "replaceState"])', 'window.addEventListener("popstate", recordVisit)');
  assert.match(wrapper, /method === "pushState"\) saveScrollPosition\(\)/);
  assert.match(wrapper, /state == null && savedScrollPosition\(\) != null/);
});

test("saving a spot bypasses the visit-recording wrapper", () => {
  const save = between("function saveScrollPosition()", "\n}");
  assert.match(save, /rawReplaceState\(/);
  assert.doesNotMatch(save, /history\.replaceState\(/);
});

test("boot and Back/Forward restore the saved spot for documents and every VIEWS page", () => {
  const boot = between("const requestedView = ", "connectLiveUpdates();");
  assert.match(boot, /VIEWS\[requestedView\]\.boot\(\); restoreSavedScroll\(\);/);
  assert.match(boot, /selectDocument\(initial, \{[^}]*scrollY: savedScrollPosition\(\)/);
  const popstate = between('window.addEventListener("popstate", () => {', "\n});");
  assert.match(popstate, /page\.back\(params\); return restoreSavedScroll\(\);/);
  assert.match(popstate, /selectDocument\(path, \{[^}]*scrollY: savedScrollPosition\(\)/);
});

test("a document jumps to its #section only when there is no saved spot", () => {
  const select = between("async function selectDocument(", "\n}");
  assert.match(select, /if \(scrollY != null\) restoreScroll\(scrollY\);\s*else window\.requestAnimationFrame\(\(\) => scrollToDocumentAnchor\(anchor\)\)/);
  // Nothing else scrolls to the URL's hash on its own.
  assert.equal([...source.matchAll(/scrollToDocumentAnchor\(/g)].length, 3, "definition, selectDocument, and the in-page link handler");
});
