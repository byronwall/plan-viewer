// A fictional /api/chat-threads answer for screenshots: the acme team's week from examples/workspace, as Codex and
// Claude Code threads. The real endpoint reads this Mac's own sessions, which must never reach a published image.
export function sampleChatThreads(now = Date.now()) {
  const min = 60_000;
  const ago = (minutes) => now - minutes * min;
  const root = "/Users/dev/acme";
  let next = 0;
  const thread = (fields) => {
    const id = fields.id || `sample-${++next}`;
    const provider = fields.provider || "Claude";
    return {
      id, provider, source: "Desktop", cwd: `${root}/orbit`, state: "completed", updatedAt: ago(30), startedAt: ago(90),
      url: provider === "Codex" ? `codex://threads/${id}` : `claude://claude.ai/epitaxy/${id}`, ...fields,
    };
  };
  const claude = (tokens) => ({ tokens, usage: { tokens, input: Math.round(tokens * 0.996), cached: Math.round(tokens * 0.98), output: Math.round(tokens * 0.004) } });
  const threads = [
    thread({ id: "invites", title: "TASK-0103 · Ship workspace invites", cwd: `${root}/orbit-invites`, branch: "invites/accept-flow", model: "claude-opus-5-5", effort: "high", state: "waiting", updatedAt: ago(2), startedAt: ago(48), ...claude(8_420_000) }),
    thread({ parent: "invites", kind: "agent", title: "Invite email templates", cwd: `${root}/orbit-invites`, model: "claude-opus-5-5", effort: "medium", state: "active", updatedAt: ago(1), startedAt: ago(30), ...claude(2_310_000) }),
    thread({ parent: "invites", kind: "agent", title: "Accept endpoint tests", cwd: `${root}/orbit-invites-tests`, branch: "invites/accept-tests", model: "claude-sonnet-5-5", effort: "medium", updatedAt: ago(9), startedAt: ago(28), ...claude(1_180_000) }),

    thread({ id: "coldstart", provider: "Codex", title: "TASK-0101 · Cut dashboard cold start under two seconds", branch: "perf/cold-start", model: "gpt-6-astra", effort: "high", state: "active", updatedAt: ago(0), startedAt: ago(64), tokens: 21_600_000 }),
    thread({ parent: "coldstart", provider: "Codex", kind: "subagent", nickname: "Kepler", role: "profile_bundle", title: "profile bundle", model: "gpt-6-luna", effort: "high", state: "active", updatedAt: ago(0), startedAt: ago(52), tokens: 5_240_000 }),
    thread({ parent: "coldstart", provider: "Codex", kind: "subagent", nickname: "Hypatia", role: "lazy_load_charts", title: "lazy load charts", model: "gpt-6-luna", effort: "high", updatedAt: ago(12), startedAt: ago(51), tokens: 3_960_000 }),
    thread({ parent: "coldstart", provider: "Codex", kind: "subagent", nickname: "Pascal", role: "measure_cold_start", title: "measure cold start", model: "gpt-6.1-terra", effort: "medium", state: "active", updatedAt: ago(1), startedAt: ago(50), tokens: 1_870_000 }),

    thread({ title: "TASK-0105 · Quarantine flaky end-to-end tests", source: "CLI", url: `claude://resume?session=e2e`, branch: "ci/quarantine", model: "claude-opus-5-5", effort: "medium", state: "background", updatedAt: ago(6), startedAt: ago(40), tasks: [{ kind: "command", label: "Run the e2e suite 20 times" }], ...claude(4_050_000) }),
    thread({ provider: "Codex", title: "TASK-0102 · Move billing webhooks to the queue", cwd: `${root}/orbit-webhooks`, branch: "billing/queue", model: "gpt-6.1-sol", effort: "medium", state: "background", updatedAt: ago(4), startedAt: ago(35), tokens: 9_310_000, tasks: [{ kind: "command", label: "pnpm worker:dev" }] }),

    thread({ title: "TASK-0104 · Write the self-hosting guide", model: "claude-fable-5-2", effort: "medium", updatedAt: ago(75), startedAt: ago(160), ...claude(6_720_000) }),
    thread({ provider: "Codex", title: "Review PR #212 · webhook retries", cwd: `${root}/orbit-webhooks`, branch: "billing/retries", model: "gpt-6.1-sol", effort: "high", updatedAt: ago(130), startedAt: ago(150), tokens: 2_140_000 }),
    thread({ provider: "Codex", source: "CLI", title: "Bisect the login test that fails on CI only", model: "gpt-6-luna", effort: "xhigh", state: "interrupted", updatedAt: ago(190), startedAt: ago(230), tokens: 760_000 }),
    thread({ id: "plan", title: "Daily plan · Thursday", cwd: `${root}/planning`, model: "claude-fable-5-2", effort: "low", updatedAt: ago(300), startedAt: ago(310), ...claude(1_420_000) }),
    thread({ parent: "plan", kind: "agent", title: "Sweep Up next", cwd: `${root}/planning`, model: "claude-opus-5-5", effort: "medium", updatedAt: ago(280), startedAt: ago(305), ...claude(2_050_000) }),

    thread({ title: "Retire the invites plan after merge", cwd: `${root}/planning`, model: "claude-opus-5-5", effort: "medium", updatedAt: ago(26 * 60), startedAt: ago(27 * 60), ...claude(3_300_000) }),
    thread({ provider: "Codex", title: "Pin the chart library before the upgrade", model: "gpt-6.1-sol", effort: "medium", updatedAt: ago(29 * 60), startedAt: ago(30 * 60), tokens: 1_150_000 }),
  ];
  const finished = (item) => item.state === "completed" || item.state === "interrupted";
  return { active: threads.filter((item) => !finished(item)), completed: threads.filter(finished), issues: [] };
}
