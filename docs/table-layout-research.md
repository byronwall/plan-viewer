# Table layout research: compare the greedy fit with wrap breakpoints

- origin: repo-reading-brief
- Source edition: [November 12 2026 Relationship history and readable evidence](https://chatgpt.com/space/page_ec5b7b06bfec819186659ec321011016)
- Stable topic ID: `plan-viewer.table-wrap-breakpoint-oracle.v1`
- Status: research proposal; no application changes or benchmark results
- Inspected baseline: `43e0222be383d63cb344c71f248adf724ea44a5e`

## Decision to investigate

Keep the current fast, dependency-free table layout. Before refining its heuristic, build a small offline reference experiment that measures how much height the heuristic leaves on the table, if any, under the same readable-width constraints. Use actual browser wrap breakpoints rather than treating character width as a smooth predictor of line count.

This is not a proposal to ship an optimization solver, add a package, or rewrite table rendering. A negative result is useful: if the current allocation is close enough and easy to read, retain it. No defect has been reproduced.

## What exists today

[public/table-fit.js](../public/table-fit.js) measures the header and first 300 body rows. A maximum-width pass obtains natural text widths, and a minimum-width pass obtains column minima. Short links and code remain unbroken; long links receive special wrapping that keeps the trailing external mark with their last word. The implementation begins at readable widths (120 px floor bounded by measured minima and maxima), then allocates spare width in 8 px steps according to the estimated reduction in summed row heights. That estimate uses natural text width divided by usable column width, with each row governed by its tallest estimated cell.

This is already more thoughtful than equal-width columns. It honors narrow short fields and gives prose useful room. It also deliberately permits horizontal scrolling when readable minima cannot fit. Tall-table caps, sticky headers, Show all, Expand, and the visible row range solve separate navigation problems and should remain unchanged.

The possible gap is an inference: real line wrapping changes discretely, while the estimate changes smoothly. A small increment may cross an important wrap breakpoint in one column, or may save no actual line. The first-300 sample also means a later unusual row may not influence the estimated objective. Neither observation alone proves a visible problem.

## Source mechanism

Primary inspected source: GAMS Development Corporation, [Configuring text layout in table cells to minimize table height](https://www.gams.com/latest/gamslib_ml/libhtml/gamslib_tablelayout.html), living model-library page, inspected November 12, 2026; no publication date displayed. It provides complete column-, row-, and constraint-based formulations. Its cited research is Mihai Bilauca and Patrick Healy, [A new model for automated table layout](https://doi.org/10.1145/1860559.1860594), DocEng 2010. The paper is a bibliographic lead here, not claimed full-text evidence.

The model takes finite width/height configurations for cells. A column must accommodate its selected cell widths; a row must accommodate its tallest cell. Total column width is bounded by the available page width and the objective minimizes total row height. This separates possible wraps from the optimization that chooses among them.

That formulation supplies an experimental reference, not browser typography. Plan Viewer must measure its own font, line height, padding, borders, link marks, code, and wrapping rules. Height minimization also does not establish reading quality, layout stability, or acceptable runtime. No source code or solver package needs to be copied into the application.

## Small validation experiment

Use a separate disposable checkout and synthetic acme content. Keep real planning files and messages out of fixtures. Read AGENTS.md and the UI-taste skill before any later UI implementation; this research document authorizes no such change.

1. Pin the tested commit, browser version, viewport, device scale, font readiness and CSS. Save the exact rendered HTML and fixture source. Wait for fonts before measuring.
2. Begin with 3 columns and 5 rows. Include short identifiers, dates, a prose description, a long unbroken token, inline code, and a link with its external mark. Use widths 390, 768, 1280 and 1440 px, but record the table frame's actual available width, not only the viewport.
3. For each candidate column width, measure the real cell block height with the existing styles. Collapse equivalent configurations: retain the smallest width for each distinct measured height. Include existing minima, maximum widths, padding and borders consistently.
4. Enumerate combinations of retained column widths only for this tiny case. Reject sums above the frame width; compute each row height as the maximum measured cell height, then sum. Render every winning combination in the real table to verify the predicted result. Call it optimal only within the explicitly enumerated candidate set, not across all CSS layouts.
5. Compare the unchanged current heuristic against that reference, native automatic table layout as a contextual baseline, and a simple equal-width allocation only where readable minima permit it. Do not weaken the current wrapping/readability rules to favor the reference.
6. Add a second fixture with 301 body rows. Keep rows 1–300 ordinary, then place one atypical long row at position 301. Repeat after moving that same row to position 1. Report sample sensitivity separately from greedy-allocation quality.
7. Repeat at widths just below and above discovered breakpoints. Test resize back to the original width to see whether the same content returns to the same layout. Add a font-ready versus delayed-font check as a separate lifecycle observation, not evidence against the objective itself.

Do not compare a solver's offline time with the heuristic's browser time as if they had the same deployment purpose. Measure cell-configuration generation, reference search, heuristic calculation and actual browser layout separately. If the candidate count explodes, stop or reduce the fixture; do not introduce a production dependency to complete this study.

## Evidence to retain

| Measure | Why it matters |
| --- | --- |
| Actual full table height, with cap disabled only in the experimental copy | Avoid confusing the scroll frame height with the content objective |
| Width overflow, clipped content, broken links/code | Shorter is unacceptable if evidence becomes unreadable |
| Per-row measured height and chosen column widths | Explain which breakpoint caused any gain |
| Current/reference height ratio | Quantifies opportunity without promising a speedup |
| Measurement, allocation and layout duration separately | Distinguishes better geometry from added browser cost |
| Width change across neighboring frame sizes | Detects unstable allocations |
| Fixed reading task accuracy and time | Tests whether less height actually helps people |

A small reading task could ask a reviewer to find an acme milestone's owner and explain its blocker, or compare two rows' deadlines and notes. Counterbalance layout order and retain errors as well as time. Treat a handful of internal trials as formative evidence, not a population-level usability claim.

Save a compact report, raw measurements, synthetic fixtures, paired viewport screenshots and reproduction commands outside the runtime path. Record unsuccessful or equivalent cases, not just the largest improvement. Preserve the original Markdown and verify that copy/download still means the same source or selected rows; this is not a new content transformation.

## Decision gates and next steps

- If the heuristic consistently stays close to the candidate reference and reading performance does not improve, close the investigation with no product change.
- If a few wrap-boundary cases dominate, investigate a bounded local breakpoint lookahead rather than a solver migration.
- If the 301st-row case dominates, investigate sampling strategy independently. Do not credit an allocation algorithm for seeing more rows.
- If a shorter table loses readable fields, causes oscillating widths, or makes interaction slower, reject that candidate even if its height objective wins.
- If font/content changes invalidate measured widths, treat cache invalidation as a separate experiment with an explicit reproduction.

Before implementation, agree on practical budgets from observed current performance, select a small holdout fixture set, and rerun the same checks. Avoid choosing a percentage threshold after seeing which case wins. The follow-on agent should deliver evidence and a keep/change recommendation before modifying production layout.

## Deduplication and verification

Inspected current docs, AGENTS.md, the implementation and all eleven historical PRs returned for this repository. PR #7 concerns expanded-table sorting, filters and resizing; it does not provide this wrap-breakpoint evaluation. The reading coverage record has prior Plan Viewer retrieval, comparison, source-fidelity, resumption and diff topics, but no table-allocation reference study.

This packet is documentation only. Experiments above are unrun; no performance, accessibility or optimality claim is made about the current UI.
