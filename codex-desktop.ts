import { execFile } from "node:child_process";

type LogDetails = Record<string, string | number | boolean | null | undefined>;
type Logger = (stage: string, details?: LogDetails) => void;
type RunCommand = (executable: string, args: string[]) => Promise<void>;

const runCommand: RunCommand = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, (error) => error ? reject(error) : resolve());
});

export function taskTitle(chunkTitle: string) {
  const title = chunkTitle
    .replace(/^Milestone\s+\d+\s*[:—–-]?\s*/i, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
  return (title || "Plan viewer handoff").slice(0, 80);
}

// The app treats `path` as the new thread's workspace root when it is an existing directory.
export function codexNewTaskUrl(prompt: string, workspace: string) {
  if (!prompt.trim()) throw new Error("Cannot open an empty Codex task.");
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", workspace);
  url.searchParams.set("prompt", prompt);
  return url.toString();
}

// Claude Desktop opens a local session preset (an "environment" in its picker) from the preset's folder; its own
// deep links send `folder=<cwd>` for one. `environment=` names only cloud environment IDs, so a local preset's name
// there is ignored and the draft lands in the default preset instead.
// Claude Desktop sometimes drops `folder` between opening the draft and sending it, starting the session in a "No
// folder" scratch workspace. The prompt names the folder too, so the agent can move itself there. change_directory
// only takes effect when the turn ends, so the first turn still runs without the folder's instructions and skills.
export function claudeNewSessionUrl(folder: string, prompt = "") {
  if (prompt) prompt += `\n\nThis session belongs in ${folder}. If your working directory is anything else, call change_directory with ${folder} before reading or editing anything. The move takes effect only when your turn ends, so until then: use absolute paths under ${folder}, read ${folder}/CLAUDE.md (or AGENTS.md) yourself, and when a task matches a skill under ${folder}/.claude/skills/ or ${folder}/.agents/skills/, read its SKILL.md and follow it.`;
  return `claude://code/new?${new URLSearchParams({ ...(prompt ? { q: prompt } : {}), folder })}`;
}

// Neither app's deep link carries attachments, so pasted images travel as workspace file paths the agent opens.
export function withImages(prompt: string, images: string[]) {
  return images.length ? `${prompt}\n\nAttached images (pasted into the handoff; open each file to view it):\n${images.map(path => `- ${path}`).join("\n")}` : prompt;
}

export class CodexDesktopClient {
  private log: Logger;
  private run: RunCommand;
  private platform: NodeJS.Platform;

  constructor(log: Logger = () => {}, options: { run?: RunCommand; platform?: NodeJS.Platform } = {}) {
    this.log = log;
    this.run = options.run || runCommand;
    this.platform = options.platform || process.platform;
  }

  async openDraft(cwd: string, title: string, prompt: string, app = "codex", images: string[] = []) {
    if (this.platform !== "darwin") throw new Error("Opening an agent draft currently requires macOS.");

    prompt = withImages(prompt, images);
    const url = app === "claude" ? claudeNewSessionUrl(cwd, prompt) : codexNewTaskUrl(prompt, cwd);
    await this.run("/usr/bin/open", [url]);
    this.log("desktop-draft-opened", { app, title: taskTitle(title), promptLength: prompt.length, workspace: cwd });
    return { draftOpened: true };
  }
}
