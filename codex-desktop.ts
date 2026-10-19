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

export class CodexDesktopClient {
  private log: Logger;
  private run: RunCommand;
  private platform: NodeJS.Platform;

  constructor(log: Logger = () => {}, options: { run?: RunCommand; platform?: NodeJS.Platform } = {}) {
    this.log = log;
    this.run = options.run || runCommand;
    this.platform = options.platform || process.platform;
  }

  async openDraft(cwd: string, title: string, prompt: string) {
    if (this.platform !== "darwin") throw new Error("Opening a Codex draft currently requires macOS.");

    const url = codexNewTaskUrl(prompt, cwd);
    await this.run("/usr/bin/open", [url]);
    this.log("desktop-draft-opened", { title: taskTitle(title), promptLength: prompt.length, workspace: cwd });
    return { draftOpened: true };
  }
}
