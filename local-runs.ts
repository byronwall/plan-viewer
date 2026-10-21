import { spawn, type ChildProcess } from "node:child_process";

// Long-running local servers started from the Code page, one per worktree path. Each runs in its own process
// group so Stop (and the viewer exiting) takes down whatever the command spawned too.
type Run = { path: string; command: string[]; child: ChildProcess | null; startedAt: number; url: string; log: string[]; exitCode: number | null };

const LOG_LINES = 200;
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+[^\s'"]*/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function createLocalRuns() {
  const runs = new Map<string, Run>();

  const stopGroup = (run: Run) => {
    if (!run.child?.pid || run.exitCode !== null) return;
    try { process.kill(-run.child.pid, "SIGTERM"); } catch {}
  };
  process.on("exit", () => { for (const run of runs.values()) stopGroup(run); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit());

  function start(path: string, command: string[]) {
    const existing = runs.get(path);
    if (existing && existing.exitCode === null) return summary(existing);
    const run: Run = { path, command, child: null, startedAt: Date.now(), url: "", log: [`$ ${command.join(" ")}`], exitCode: null };
    runs.set(path, run);
    const child = spawn(command[0], command.slice(1), { cwd: path, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
    run.child = child;
    let partial = "";
    const take = (chunk: Buffer) => {
      const lines = (partial + chunk.toString()).replace(ANSI, "").split(/\r?\n/);
      partial = lines.pop() || "";
      for (const line of lines) {
        // The first local URL a dev command prints is the app; later ones are usually its backends.
        if (!run.url) run.url = line.match(URL_PATTERN)?.[0] || "";
        run.log.push(line);
      }
      if (run.log.length > LOG_LINES) run.log.splice(0, run.log.length - LOG_LINES);
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", (error) => { run.log.push(error.message); run.exitCode = -1; });
    child.on("exit", (code, signal) => { if (partial) run.log.push(partial); run.log.push(`Exited ${signal || code}.`); run.exitCode = code ?? -1; });
    return summary(run);
  }

  function stop(path: string) {
    const run = runs.get(path);
    if (run) stopGroup(run);
    runs.delete(path);
  }

  const summary = (run: Run) => ({ path: run.path, state: run.exitCode === null ? (run.url ? "running" : "starting") : "exited", url: run.url, startedAt: run.startedAt, exitCode: run.exitCode });
  const list = () => Object.fromEntries([...runs.values()].map((run) => [run.path, summary(run)]));
  const log = (path: string) => { const run = runs.get(path); return run ? { ...summary(run), command: run.command.join(" "), log: run.log } : null; };

  return { start, stop, list, log };
}
