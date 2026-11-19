---
title: Work item: note
sent: Note… or Decide… on a step, picked up from Up next
---

Act on {user}'s note on {id}: {item}

{facts}

Read the source file and the workspace AGENTS.md first, then any task asset whose front matter names `step: {task} {id}` (an outbound draft or other machinery for this step).

{user}'s note, in their own words:
{note}

The note is a decision, an approval or direction for this step. Record it in the task file as a dated update whose bold title names ({id}). Then carry it through: a decision gets the steps it changes reworded, added or dropped; an approval of an outbound draft is {user}'s approval to send that draft as written, or with the edits the note asks for, so send it the workspace's way and do the follow-through around it (links, labels, parent issues, references back in the task); direction gets the work it describes. A note is not a completion: afterwards set {id}'s status to what actually comes next ([open], [active], [waiting], or [completed] only when the work the note asks for finishes the step, or the note says it is done), and adjust its kind if the next move changed. If the note leaves something genuinely open, record what was said and ask instead of guessing. Run the workspace lint on the task and fix what it reports.

{chat-links}
