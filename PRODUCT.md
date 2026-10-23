# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A developer uses this local-only Mac app while reviewing daily plans and cross-day planning topics. They read structured work, choose a complete milestone or section, dictate feedback, and hand that context to a new Codex task.

## Product Purpose

Make Markdown planning files easier to scan and act on without becoming another editor. Success means today's plan opens immediately, known planning structures read as chunks of work, and one chunk plus commentary can be loaded into an editable Codex draft in seconds.

## Positioning

The viewer treats the workspace's structured Markdown as an interface: files become a library and milestones become actionable work cards, while Markdown remains the source of truth.

## Operating Context

The app runs locally on a Mac against one planning workspace, configured by its `viewer.config.json`. All document edits happen through agents. Codex Desktop or Claude Desktop, picked in the sidebar, is the destination for dispatched work.

## Capabilities and Constraints

- Read Markdown and plain-text files under `daily/`, `tasks/`, `plans/`, and authored `reference/` paths without modifying them; omit configured generated folders from the viewer.
- Prefer today's `daily/YYYY/MM/DD/plan.md` on launch.
- Keep the everyday sidebar to one line per day with fixed Plan and Done slots; reach a day's other files from its breadcrumb, and give Topics and Reference their own pages.
- List unfinished file-backed tasks on a dedicated route and enrich ordinary task links in daily plans from each task file's current summary metadata.
- Interpret milestone headings and numbered priority headings as chunks; fall back to second-level sections for general Markdown.
- Watch authored Markdown and plain-text assets, refreshing in place while preserving reading position and unsent commentary.
- Open any rendered Markdown image in a document-wide inspection modal with carousel navigation, thumbnails, pan, and zoom.
- Show executable task actions and daily next steps with a prompt preview and optional additional context; use the existing desktop draft handoff.
- Render task work breakdowns as nested scope trees and prerequisite graphs; only work items with completed prerequisites are ready.
- Load one complete chunk plus free-form commentary into a new pending Codex draft in the workspace's project; only the operator can submit it.
- No authentication, deployment, inline editing, arbitrary text selection, or live task tracking in the first version.

## Evidence on Hand

A workspace's existing daily plans, done logs, templates, and topic documents are the real content and structural examples.

## Product Principles

- Repository source files stay authoritative.
- Prefer one obvious action over configuration.
- Preserve enough source context that a new agent can act without guessing.
- Keep the viewer local, inspectable, and dependency-light.
