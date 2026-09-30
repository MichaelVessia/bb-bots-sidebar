import { afterEach, describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { backend } from "./backend-fixture";
import { TASKS_CHANGED } from "../contract";
import { isSafeTaskLink, taskLinkLabel } from "../lib/task-links";

const hosts: Awaited<ReturnType<typeof backend>>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });
async function setup() {
  const host = await backend(); hosts.push(host);
  const bot = await host.create("Atlas");
  host.threads.set("worker", makeThreadResponse({ id: "worker", projectId: "project" })); host.store.bind("worker", bot.id);
  host.threads.set("other", makeThreadResponse({ id: "other", projectId: "project" }));
  const run = (argv: string[], threadId?: string) => host.harness.behavior.runCli(["task", ...argv], threadId ? { threadId } : undefined);
  const create = async (argv: string[], threadId = "worker") => {
    const result = await run(["set", ...argv, "--json"], threadId);
    expect(result.stderr || "").toBe("");
    return JSON.parse(result.stdout!).task as { id: string; [key: string]: unknown };
  };
  const list = async () => JSON.parse((await run(["list", "--json"])).stdout!).tasks as { id: string; [key: string]: unknown }[];
  return { host, bot, run, create, list };
}

describe("Work task records", () => {
  it("creates a task owned by the invoking bot and linked to its conversation", async () => {
    const { host, bot, create } = await setup();
    const task = await create(["--title", "Move CI runners", "--status", "now", "--next", "Wait for staging deploy", "--link", "https://github.com/acme/ci/pull/130"]);
    expect(task).toMatchObject({ status: "now", botId: bot.id, threadId: "worker", updatedByThreadId: "worker", links: ["https://github.com/acme/ci/pull/130"], outcome: "" });
    expect(task.id).toMatch(/^task_[a-f0-9]{32}$/);
    expect(host.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toContain(TASKS_CHANGED);
  });

  it("merges explicit updates, replaces links, and requires an outcome for Done", async () => {
    const { run, create, list } = await setup();
    const task = await create(["--title", "Review PR", "--status", "now", "--next", "Address comments", "--link", "https://github.com/acme/app/pull/1"]);
    const waiting = await create([task.id, "--status", "waiting", "--next", "Approve the prod deploy", "--link", "https://linear.app/acme/issue/SRE-867/runners", "--link", "https://github.com/acme/app/pull/2"]);
    expect(waiting).toMatchObject({ title: "Review PR", status: "waiting", nextStep: "Approve the prod deploy", links: ["https://linear.app/acme/issue/SRE-867/runners", "https://github.com/acme/app/pull/2"] });
    expect((waiting.updatedAt as number)).toBeGreaterThan(task.updatedAt as number);
    const refused = await run(["set", task.id, "--status", "done"], "worker");
    expect(refused.exitCode).toBe(1); expect(refused.stderr).toContain("Done tasks need an outcome");
    expect((await list())[0]).toMatchObject({ status: "waiting" });
    const done = await create([task.id, "--status", "done", "--outcome", "Merged; staging passed", "--link", "none"]);
    expect(done).toMatchObject({ status: "done", outcome: "Merged; staging passed", links: [], createdAt: task.createdAt });
  });

  it("lets an unbound orchestrator assign an owner and another thread, then filters by them", async () => {
    const { bot, run, create } = await setup();
    const task = await create(["--title", "Audit", "--status", "now", "--next", "Scan repos", "--bot", "Atlas", "--thread", "worker"], "other");
    expect(task).toMatchObject({ botId: bot.id, threadId: "worker", updatedByThreadId: "other" });
    expect(JSON.parse((await run(["list", "--bot", bot.id, "--thread", "worker", "--status", "now", "--json"])).stdout!).tasks).toHaveLength(1);
    expect(JSON.parse((await run(["list", "--status", "done", "--json"])).stdout!).tasks).toHaveLength(0);
    const text = (await run(["list"])).stdout!;
    expect(text).toContain(task.id); expect(text).toContain("Scan repos");
  });

  it.each([
    [["--title", "T", "--status", "now", "--next", "N", "--link", "http://github.com/acme/app/pull/1"], "https URLs"],
    [["--title", "T", "--status", "now", "--next", "N", "--link", "https://user:secret@example.com/"], "https URLs"],
    [["--title", "T", "--status", "now", "--next", "N", "--link", "javascript:alert(1)"], "https URLs"],
    [["--title", "T", "--status", "now"], "need a next step"],
    [["--title", "T", "--status", "later", "--next", "N"], "--status must be"],
    [["--title", "Line\nbreak", "--status", "now", "--next", "N"], "single line"],
    [["--title", "T", "--status", "now", "--next", "N", "--thread", "missing"], "Conversation not found"],
    [["--title", "T", "--status", "now", "--next", "N", "--bot", "Nobody"], "Bot not found"],
    [["--status", "now", "--next", "N"], "--title and --status"],
    [["task_00000000000000000000000000000000", "--status", "now"], "Task not found"],
    [["--title", "T", "--status", "now", "--next", "N", "--unknown", "x"], "Unknown option"],
    [["--title", "T", "--status", "now", "--next", "N", ...Array.from({ length: 6 }, (_, i) => ["--link", `https://example.com/${i}`]).flat()], "links"],
  ])("rejects invalid input %j without writing a record", async (argv, message) => {
    const { run, list } = await setup();
    const result = await run(["set", ...argv], "worker");
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain(message);
    expect(await list()).toEqual([]);
  });

  it("requires an explicit owner when the caller belongs to no bot", async () => {
    const { run, list } = await setup();
    const result = await run(["set", "--title", "T", "--status", "now", "--next", "N"], "other");
    expect(result.exitCode).toBe(1); expect(result.stderr).toContain("--bot");
    expect(await list()).toEqual([]);
  });

  it("serves public bot fields only, removes tasks, and survives a plugin reload", async () => {
    const { host, bot, run, create } = await setup();
    const kept = await create(["--title", "Keep", "--status", "waiting", "--next", "Decide"]);
    const dropped = await create(["--title", "Drop", "--status", "now", "--next", "N"]);
    expect((await run(["remove", dropped.id])).exitCode).toBe(0);
    expect((await run(["remove", dropped.id])).exitCode).toBe(1);
    await host.reload();
    const view = await host.harness.behavior.callRpc("tasks_list", null) as { tasks: { id: string }[]; bots: object[] };
    expect(view.tasks.map((task) => task.id)).toEqual([kept.id]);
    expect(view.bots).toEqual([{ id: bot.id, name: "Atlas", role: "Research", avatar: bot.avatar, mainThreadId: bot.mainThreadId }]);
    expect(JSON.stringify(view)).not.toContain("You are Atlas");
  });
});

describe("decision detail and acknowledgement", () => {
  it("stores explicit context, recommendation, options, and ask thread, and replaces or clears options", async () => {
    const { create } = await setup();
    const task = await create(["--title", "Pick rollout", "--status", "waiting", "--next", "Choose a rollout window", "--context", "Two windows are free.",
      "--recommendation", "Tuesday", "--option", "Tuesday 9am", "--option", "Thursday 2pm", "--ask-thread", "other"]);
    expect(task).toMatchObject({ context: "Two windows are free.", recommendation: "Tuesday", options: ["Tuesday 9am", "Thursday 2pm"], askThreadId: "other", acknowledgedAt: null });
    expect(await create([task.id, "--option", "none"])).toMatchObject({ options: [], askThreadId: "other" });
  });

  it("defaults the ask thread to the creating conversation and validates it", async () => {
    const { run, create } = await setup();
    expect(await create(["--title", "T", "--status", "now", "--next", "N", "--bot", "Atlas"], "other")).toMatchObject({ askThreadId: "other" });
    for (const argv of [["--ask-thread", "missing"], ["--option", "one\ntwo"], ["--option", "none", "--option", "x"]]) {
      const result = await run(["set", "--title", "T", "--status", "now", "--next", "N", ...argv], "worker");
      expect(result.exitCode).toBe(1);
    }
  });

  it("acknowledges only Done results without changing progress, and any update clears it", async () => {
    const { host, create } = await setup();
    const now = await create(["--title", "T", "--status", "now", "--next", "N"]);
    await expect(host.harness.behavior.callRpc("task_acknowledge", { taskId: now.id, acknowledged: true })).rejects.toThrow("Only Done tasks");
    const done = await create([now.id, "--status", "done", "--outcome", "Merged"]);
    host.harness.inspection.realtimeSignals.length = 0;
    const acknowledged = await host.harness.behavior.callRpc("task_acknowledge", { taskId: done.id, acknowledged: true }) as { acknowledgedAt: number; updatedAt: number };
    expect(acknowledged.acknowledgedAt).toBeTypeOf("number");
    expect(acknowledged.updatedAt).toBe(done.updatedAt);
    expect(host.harness.inspection.realtimeSignals.map((signal) => signal.channel)).toEqual([TASKS_CHANGED]);
    expect(await create([done.id, "--outcome", "Merged and deployed"])).toMatchObject({ acknowledgedAt: null });
  });

  it("reads records written before the decision fields existed", async () => {
    const { host, bot } = await setup();
    const legacy = { id: `task_${"a".repeat(32)}`, title: "Old", status: "waiting", botId: bot.id, threadId: "worker", links: [], nextStep: "Decide", outcome: "", createdAt: 1, updatedAt: 2, updatedByThreadId: "other" };
    host.bb.storage.database().prepare("INSERT INTO bot_tasks(id,data,updated_at) VALUES (?,?,?)").run(legacy.id, JSON.stringify(legacy), 2);
    const view = await host.harness.behavior.callRpc("tasks_list", null) as { tasks: object[]; threadBots: Record<string, string> };
    expect(view.tasks).toEqual([{ ...legacy, context: "", recommendation: "", options: [], askThreadId: null, acknowledgedAt: null, needsAcknowledgement: false, waitingOn: null, waitingFor: "" }]);
    expect(view.threadBots).toEqual({ worker: bot.id });
  });
});

describe("owner threads", () => {
  it("labels each task owner's selected main so the panel links it only while the bot still owns it", async () => {
    const { host, bot, create } = await setup();
    host.threads.set("main", makeThreadResponse({ id: "main", projectId: "project" })); host.store.bind("main", bot.id);
    host.store.save({ ...host.store.require(bot.id), mainThreadId: "main" });
    await create(["--title", "Linked", "--status", "now", "--next", "N"]);
    const view = await host.harness.behavior.callRpc("tasks_list", null) as { bots: { mainThreadId: string | null }[]; threadBots: Record<string, string> };
    expect(view.bots.map((entry) => entry.mainThreadId)).toEqual(["main"]);
    expect(view.threadBots).toEqual({ worker: bot.id, main: bot.id });
    host.store.save({ ...host.store.require(bot.id), mainThreadId: "other" });
    const foreign = await host.harness.behavior.callRpc("tasks_list", null) as { threadBots: Record<string, string> };
    expect(foreign.threadBots.other).toBeUndefined();
    expect((foreign as unknown as { archivedThreadIds: string[] }).archivedThreadIds).toEqual([]);
    host.threads.set("worker", makeThreadResponse({ id: "worker", projectId: "project", archivedAt: 5 }));
    const archived = await host.harness.behavior.callRpc("tasks_list", null) as { archivedThreadIds: string[] };
    expect(archived.archivedThreadIds).toEqual(["worker"]);
  });
});

describe("needs acknowledgement", () => {
  it("keeps legacy Done records as history without pretending they were acknowledged", async () => {
    const { host, bot } = await setup();
    const db = host.bb.storage.database();
    const base = { botId: bot.id, threadId: "worker", links: [], nextStep: "", outcome: "Shipped", createdAt: 1, updatedAt: 2, updatedByThreadId: null, status: "done" };
    const legacy = { ...base, id: `task_${"1".repeat(32)}`, title: "Old unread" };
    const seen = { ...base, id: `task_${"2".repeat(32)}`, title: "Old seen", acknowledgedAt: 5 };
    for (const record of [legacy, seen]) db.prepare("INSERT INTO bot_tasks(id,data,updated_at) VALUES (?,?,?)").run(record.id, JSON.stringify(record), 2);
    const view = await host.harness.behavior.callRpc("tasks_list", null) as { tasks: { id: string; needsAcknowledgement: boolean; acknowledgedAt: number | null }[] };
    expect(Object.fromEntries(view.tasks.map((task) => [task.id, [task.needsAcknowledgement, task.acknowledgedAt]]))).toEqual({ [legacy.id]: [false, null], [seen.id]: [false, 5] });
  });

  it("flags new and updated Done results for acknowledgement, persists acknowledgement, and never flags Michael's own Done", async () => {
    const { host, create } = await setup();
    const done = await create(["--title", "C4 draft", "--status", "done", "--outcome", "Draft saved"]);
    expect(done).toMatchObject({ needsAcknowledgement: true, acknowledgedAt: null });
    const read = await host.harness.behavior.callRpc("task_acknowledge", { taskId: done.id, acknowledged: true }) as { needsAcknowledgement: boolean; acknowledgedAt: number };
    expect(read.needsAcknowledgement).toBe(false);
    await host.reload();
    const reloaded = (await host.harness.behavior.callRpc("tasks_list", null) as { tasks: { id: string; needsAcknowledgement: boolean; acknowledgedAt: number | null }[] }).tasks.find((task) => task.id === done.id)!;
    expect(reloaded).toMatchObject({ needsAcknowledgement: false, acknowledgedAt: read.acknowledgedAt });
    expect(await create([done.id, "--outcome", "Draft saved and shared"])).toMatchObject({ needsAcknowledgement: true, acknowledgedAt: null });
    expect(await host.harness.behavior.callRpc("task_acknowledge", { taskId: done.id, acknowledged: false })).toMatchObject({ needsAcknowledgement: true, acknowledgedAt: null });
    const mine = await create(["--title", "Mine", "--status", "now", "--next", "N"]);
    expect(await host.harness.behavior.callRpc("task_set_status", { taskId: mine.id, status: "done", outcome: "I did it" })).toMatchObject({ needsAcknowledgement: false, acknowledgedAt: null });
    expect(await create([mine.id, "--status", "now", "--next", "Again"])).toMatchObject({ needsAcknowledgement: false });
  });
});

describe("waiting owner", () => {
  it("records who holds the next action and clears it when the task leaves Waiting", async () => {
    const { run, create } = await setup();
    const task = await create(["--title", "Chrome prompt", "--status", "waiting", "--next", "Change the policy", "--waiting-on", "other", "--waiting-for", "Mosyle administrator"]);
    expect(task).toMatchObject({ waitingOn: "other", waitingFor: "Mosyle administrator" });
    expect(await create([task.id, "--waiting-on", "michael"])).toMatchObject({ waitingOn: "michael", waitingFor: "" });
    expect(await create([task.id, "--status", "now"])).toMatchObject({ waitingOn: null, waitingFor: "" });
    expect(await create(["--title", "Unset", "--status", "waiting", "--next", "N"])).toMatchObject({ waitingOn: null });
    for (const argv of [["--waiting-on", "boss"], ["--waiting-for", "x".repeat(121)], ["--waiting-for", "a\nb"]]) {
      expect((await run(["set", task.id, "--status", "waiting", ...argv], "worker")).exitCode).toBe(1);
    }
  });

  it("reads and accepts the older external owner as someone else, keeping the name", async () => {
    const { host, bot, run, create } = await setup();
    const stored = { id: `task_${"e".repeat(32)}`, title: "Vendor fix", status: "waiting", botId: bot.id, threadId: "worker", links: [], nextStep: "Ship the fix", outcome: "", createdAt: 1, updatedAt: 2, updatedByThreadId: null, waitingOn: "external", waitingFor: "Mosyle support" };
    host.bb.storage.database().prepare("INSERT INTO bot_tasks(id,data,updated_at) VALUES (?,?,?)").run(stored.id, JSON.stringify(stored), 2);
    const view = await host.harness.behavior.callRpc("tasks_list", null) as { tasks: { waitingOn: string; waitingFor: string }[] };
    expect(view.tasks[0]).toMatchObject({ waitingOn: "other", waitingFor: "Mosyle support" });
    expect(await create([stored.id, "--waiting-on", "external"])).toMatchObject({ waitingOn: "other", waitingFor: "Mosyle support" });
    expect(JSON.parse((host.bb.storage.database().prepare("SELECT data FROM bot_tasks WHERE id = ?").get(stored.id) as { data: string }).data).waitingOn).toBe("other");
    expect((await host.harness.behavior.callRpc("task_set_status", { taskId: stored.id, status: "waiting", waitingOn: "external", waitingFor: "Vendor" }) as { waitingOn: string }).waitingOn).toBe("other");
    expect((await run(["--help"])).stdout).not.toContain("michael|other|agent|external");
  });

  it("lets Michael move tasks without notes, keeping owners and metadata, while agents still must describe work", async () => {
    const { host, run, create } = await setup();
    const task = await create(["--title", "PR review", "--status", "waiting", "--next", "Review", "--waiting-on", "agent", "--waiting-for", "Codex", "--context", "Keep me"]);
    const call = (input: object) => host.harness.behavior.callRpc("task_set_status", { taskId: task.id, ...input }) as Promise<Record<string, unknown>>;
    // Entering Waiting on others keeps the existing non-Michael owner and name.
    expect(await call({ status: "waiting" })).toMatchObject({ waitingOn: "agent", waitingFor: "Codex", context: "Keep me", nextStep: "Review", updatedByThreadId: null, askThreadId: "worker" });
    const done = await call({ status: "done" });
    expect(done).toMatchObject({ status: "done", outcome: "", needsAcknowledgement: false, waitingOn: null, context: "Keep me" });
    expect(await call({ status: "waiting" })).toMatchObject({ waitingOn: "other", waitingFor: "" });
    expect(await call({ status: "now", nextStep: "" })).toMatchObject({ status: "now", nextStep: "" });
    expect(await call({ status: "now", nextStep: "Follow up" })).toMatchObject({ nextStep: "Follow up" });
    // Records Michael left without notes stay readable, and agents still need them.
    expect((await host.harness.behavior.callRpc("tasks_list", null) as { tasks: unknown[] }).tasks).toHaveLength(1);
    const agentDone = await run(["set", task.id, "--status", "done"], "worker");
    expect(agentDone.exitCode).toBe(1); expect(agentDone.stderr).toContain("Done tasks need an outcome");
  });
});

describe("task links", () => {
  it("labels PRs and issues and accepts only credential-free https URLs", () => {
    expect(taskLinkLabel("https://github.com/flocasts/flo-control/pull/130")).toEqual({ kind: "pr", label: "flo-control#130" });
    expect(taskLinkLabel("https://github.com/acme/app/issues/7")).toEqual({ kind: "issue", label: "app#7" });
    expect(taskLinkLabel("https://linear.app/acme/issue/sre-867/move-runners")).toEqual({ kind: "issue", label: "SRE-867" });
    expect(taskLinkLabel("https://acme.atlassian.net/browse/AD-1107")).toEqual({ kind: "issue", label: "AD-1107" });
    expect(taskLinkLabel("https://example.com/report")).toEqual({ kind: "link", label: "example.com" });
    for (const bad of ["http://example.com", "https://a:b@example.com", "https://example.com/a b", `https://example.com/${"x".repeat(500)}`, "not a url"]) expect(isSafeTaskLink(bad)).toBe(false);
  });
});
