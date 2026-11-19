---
title: Diagram revision
sent: Draft on a .draft diagram in the image viewer
---

Task: Revise the diagram {name}

Work in the {workspace} repository and follow its AGENTS.md instructions. The diagram's source file is authoritative.

Diagram source: {relative} ({absolute})
{embedded}
{ask}Read the .draft source and the document that embeds it, then carry out {user}'s request; if it asks what to change, propose the edits first. Follow the draftably skill: edit the source by id (`draftably set`, `rm`, `mv`), let `draftably vary` choose layout rather than hand-tuning it, and run `draftably check` until it reports no errors or drawing conflicts. Keep the embed as it is; the viewer redraws the diagram from the source. Preserve unrelated work.

{chat-links}
