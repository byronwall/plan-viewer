---
name: Daily Plan Viewer
description: A focused local reading desk for turning Markdown milestones into Codex work.
colors:
  ink: "#18212f"
  muted: "#657084"
  canvas: "#eef1f5"
  paper: "#ffffff"
  rail: "#f8f9fb"
  line: "#d9dee7"
  line-strong: "#bfc7d4"
  line-hover: "#aeb8ca"
  action: "#3157d5"
  action-deep: "#2444ad"
  action-ink: "#1d3eae"
  action-muted: "#5066ad"
  selected: "#e7ecff"
  success: "#17725b"
  success-ink: "#105b49"
  success-field: "#e1f3ed"
  success-soft: "#dff1eb"
  status-open-field: "#e3e7ed"
  status-open-ink: "#465268"
  status-waiting-field: "#f8e9c9"
  status-waiting-ink: "#754b00"
  status-deferred-field: "#ece7f5"
  status-deferred-ink: "#5d477b"
  danger: "#a23b35"
  danger-field: "#f7e8e7"
  body-ink: "#344055"
  control-ink: "#344057"
  code-ink: "#2c3e69"
  code-field: "#f0f2f6"
  code-block: "#f6f7fa"
  hover-field: "#f7f8fa"
  quiet-field: "#edf0f5"
  quiet-text: "#8792a4"
  search-text: "#7b8597"
  label-text: "#7a8495"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.5rem)"
    fontWeight: 750
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0.035em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(1.12rem, 2.3vw, 1.45rem)"
    fontWeight: 680
    lineHeight: 1.25
  reading:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.65
  control:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 650
    lineHeight: 1.2
  metadata:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.68rem"
    fontWeight: 650
    lineHeight: 1.2
rounded:
  xs: "5px"
  sm: "8px"
  field: "9px"
  md: "10px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "28px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "14px 22px 16px"
---

# Design System: Daily Plan Viewer

## Overview

**Creative North Star: "The Review Stack"**

The interface feels like a prepared stack of work under review: structured, quiet, and quick to mark up. The document library is deliberately denser than the reading surface, while each work chunk has enough room to read as a complete thought.

## Colors

Cool neutral surfaces keep long planning sessions comfortable. One clear blue marks selection and action; amber marks a draft that has been loaded but still awaits the operator's review and submission.

## Typography

System sans-serif type keeps the local utility fast and familiar. Monospace appears only for paths and compact metadata.

## Layout

A fixed-width document library sits beside the reading surface. On wide viewports, the full milestone cards retain a readable center column while a compact contents rail stays sticky on the right. The contents rail is omitted when a genuine third column cannot fit. Below 820px, the document library becomes a compact picker above the content.

## Elevation & Depth

Reading cards are flat: a 1px line border on the cool canvas, no shadow. Shadows are reserved for floating layers (popovers, menus, hover cards, dialogs, toasts). Selected or active state is communicated with color and focus outline, not additional layers. Never nest cards or bordered boxes inside a card.

## Shapes

Reading cards use 10px corners; controls use 8px corners. Pills are limited to small status and type labels that carry state. One-line content never gets its own border, and nothing gets a side or left accent border.

## Components

### Cards / Containers

Milestone cards contain a compact ordinal, a strong title, rendered Markdown, and one explicit handoff action. The persistent sidebar action and `⌘K` open a context-free command prompt. A document-header action opens the prompt with only the current repository-relative file path attached, while card-level actions attach their selected chunk and a compact four-line source excerpt. Every prompt grows with the instruction and protects non-empty drafts until they are explicitly canceled or loaded into Codex. Loading a draft brings Codex forward with the prepared message still editable and pending; only the operator submits it from Codex.

The contents rail is navigation, not a second content layer: its first column contains each chunk's ordinal and full title, uses no elevation, and links to the corresponding full card. On wide screens, the rail uses otherwise empty horizontal space for progressive disclosure: the active chunk reveals its immediate child headings in a fixed-width second column, and an active child can reveal one more fixed-width column. The three-column cap keeps every slice spatially stable. Each newly revealed list is vertically centered beside the parent that disclosed it, clamped to the rail when its content is too tall, so pointer travel is primarily horizontal. Selection follows the current reading position during manual scrolling, while an explicit navigation jump pins the chosen branch until its smooth scroll settles. Handoff actions remain exclusively on the full cards.

Rendered Markdown images open fit-to-stage in a nearly full-window inspection surface so the complete source is visible before closer review. A document-wide thumbnail rail keeps comparison fast, while arrow controls and keyboard navigation move through the carousel. The dark image stage separates source material from the white review interface and supports wheel zoom, drag panning, and an explicit reset to the fitted view without adding editing or asset-management controls.

### Next actions and task maps

Next actions read as a list of bounded work: an action title, optional task attribution, a disclosed prompt, and a Prepare action button. The dialog shows the full source prompt above optional context and opens the existing desktop draft. It protects typed context and preserves it on handoff errors. Daily Next steps uses the scheduled tasks' authoritative actions.

Work breakdowns show an indented scope tree followed by a horizontally scrollable dependency graph. Nodes sit in prerequisite-depth columns, arrows point to dependent work, and ready nodes use the existing selected blue. A ready node with an associated prompt opens the action dialog. Nesting never implies a dependency.

### Navigation

The everyday sidebar stays compact: one line per day, grouped as Today and then by month, with fixed Plan and Done slots (Notes when a day has no plan). A day's other files are reached from the breadcrumb's plan/done switcher and its "+N files" menu, never listed in the sidebar. Topics and Reference are top-level entries that open dedicated list pages; Topics groups each `plans/<topic>/` folder under its README. The active sidebar entry uses a pale blue field and dark blue text.

Tasks remain outside the daily document groups. A dedicated Tasks entry opens a compact unfinished-work index whose rows expose only stable ID, title, state, and last update. Inside plans, a task link reads as inline text: its color-coded stable ID and a short description. Hover or keyboard focus reveals a small metadata card with the full title, summary, project, tags, and last update. Opening it returns to the existing document renderer and handoff controls.

## Do's and Don'ts

Byron's recurring preferences live in the global `byron-ui-taste` skill (`~/.agents/skills/byron-ui-taste/SKILL.md`). Load it before any viewer design work; the rules below are the viewer-specific subset.

### Do:

- **Do** preserve the document's natural reading order.
- **Do** keep the selected chunk visible while feedback is composed.
- **Do** use plain language for dispatch and error states.
- **Do** keep layouts dense and stable: no layout shift when results, icons, or confirmations appear.
- **Do** render light, wrapping code blocks.

### Don't:

- **Don't** turn milestones into equal-height dashboard tiles.
- **Don't** add editing controls; Markdown is changed by agents.
- **Don't** use color decoratively when it can carry state.
- **Don't** add padding, shadows, or card chrome to make a section feel finished; remove before adding.
