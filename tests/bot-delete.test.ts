import { afterEach, expect, it } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BotDeleteResult, BotMetadata } from "../contract";
import { backend, project, request } from "./backend-fixture";

type Host = Awaited<ReturnType<typeof backend>>;
const hosts: Host[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose())); });
async function setup() { const host = await backend([project(), project("other")]); hosts.push(host); return host; }
const remove = (host: Host, botId: string) => host.harness.behavior.callRpc("bot_delete", { botId }) as Promise<BotDeleteResult>;
const list = (host: Host) => host.harness.behavior.callRpc("bots_list", null) as Promise<{ bots: BotMetadata[]; threadBindings: { threadId: string; botId: string }[]; projectOwners: { projectId: string; botId: string }[] }>;
const role = (host: Host, botId: string, action: string, projectId: string) => host.harness.behavior.callRpc("state_apply", { botId, change: { target: "project", action, projectId } });
const running = { displayStatus: "active" as const, hostReconnectGraceExpiresAt: null };
function thread(host: Host, id: string, overrides: Partial<ReturnType<typeof makeThreadResponse>> = {}) {
  const row = makeThreadResponse({ id, projectId: "project", createdAt: 1, ...overrides });
  host.threads.set(id, row); return row;
}
async function botWithHistory(host: Host) {
  const atlas = await host.create("Atlas", ["project", "other"]);
  await role(host, atlas.id, "own", "project");
  const { threadId: main } = await host.harness.behavior.callRpc("conversation_create", { botId: atlas.id, request: request() }) as { threadId: string };
  thread(host, "child", { parentThreadId: main });
  thread(host, "archived", { archivedAt: 2 });
  host.store.bind("archived", atlas.id);
  return { atlas: host.store.require(atlas.id), main };
}

it("keeps every conversation and detaches it into unassigned Chats", async () => {
  const host = await setup();
  const { atlas, main } = await botWithHistory(host);
  const before = [...host.threads.keys()];
  const result = await remove(host, atlas.id);
  expect(result.detachedConversationIds).toEqual(["archived", main].sort());
  expect([...host.threads.keys()]).toEqual(before);
  for (const method of ["threads.update", "threads.archive", "threads.delete"]) expect(host.harness.inspection.sdk.callsTo(method)).toEqual([]);
  expect((await list(host)).threadBindings).toEqual([]);
  for (const id of [main, "child"]) {
    const config = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id }, project: { id: "project" } }));
    expect(config.tools).toEqual([]);
    expect(config.instructions ?? "").not.toContain("You are Atlas.");
  }
  const beryl = await host.create("Beryl", ["project"]);
  await host.harness.behavior.callRpc("conversation_assign", { botId: beryl.id, threadId: main });
  expect(host.store.owner(main)).toBe(beryl.id);
});

it("releases ownership and membership so new project threads never route to the deleted bot", async () => {
  const host = await setup();
  const { atlas } = await botWithHistory(host);
  // Release ownership explicitly, not through ON DELETE CASCADE, which needs foreign keys enabled.
  host.bb.storage.database().pragma("foreign_keys = OFF");
  const result = await remove(host, atlas.id);
  expect(result.releasedProjectIds).toEqual(["project"]);
  expect(result.leftProjectIds).toEqual(["other"]);
  expect((await list(host)).projectOwners).toEqual([]);
  expect(host.bb.storage.database().prepare("SELECT COUNT(*) AS count FROM bot_project_owners").get()).toEqual({ count: 0 });
  const fresh = thread(host, "new-project-thread", { status: "pending", originPluginId: null, createdAt: Date.now() + 1 });
  expect((await host.harness.behavior.emitThreadEvent("thread.created", { thread: fresh })).errors).toEqual([]);
  expect(host.store.owner(fresh.id)).toBeNull();
  const beryl = await host.create("Beryl", []);
  await role(host, beryl.id, "own", "project");
  expect(host.store.projectOwner("project")?.botId).toBe(beryl.id);
});

it("drops the main pointer, order, and staged conversation starts with the bot", async () => {
  const host = await setup();
  const { atlas, main } = await botWithHistory(host);
  expect(atlas.mainThreadId).toBe(main);
  host.store.stageStart("0b8f5c1e-1111-4111-8111-111111111111", atlas.id, "project");
  await remove(host, atlas.id);
  expect(host.store.get(atlas.id)).toBeNull();
  expect((await list(host)).bots).toEqual([]);
  expect(host.store.pendingStart("0b8f5c1e-1111-4111-8111-111111111111")).toBeNull();
  await expect(host.harness.behavior.callRpc("conversation_create", { botId: atlas.id, request: request() })).rejects.toThrow("Bot no longer exists");
});

it("deletes only this bot's private state and its exports", async () => {
  const host = await setup();
  const { atlas } = await botWithHistory(host);
  const beryl = await host.create("Beryl", []);
  await host.harness.behavior.callRpc("state_apply", { botId: atlas.id, change: { target: "memory", action: "append", fact: "Private fact" } });
  host.store.setState(`legacy-record:${atlas.id}`, { old: true });
  expect(readdirSync(host.stateDirectory(atlas.id)).sort()).toEqual(["MEMORY.md", "SOUL.md", "bot.json", "settings.json"]);
  expect((await remove(host, atlas.id)).warnings).toEqual([]);
  expect(existsSync(host.stateDirectory(atlas.id))).toBe(false);
  const keys = (host.bb.storage.database().prepare("SELECT key FROM bot_state").all() as { key: string }[]).map((row) => row.key);
  expect(keys.filter((key) => key.includes(atlas.id))).toEqual([]);
  expect(host.bb.storage.database().prepare("SELECT data FROM bots").all().map((row) => JSON.stringify(row))).not.toContain(expect.stringContaining("Private fact"));
  expect(readdirSync(host.stateDirectory(beryl.id)).sort()).toEqual(["MEMORY.md", "SOUL.md", "bot.json", "settings.json"]);
});

it("leaves unknown files in the export directory and reports them", async () => {
  const host = await setup();
  const atlas = await host.create("Atlas", []);
  writeFileSync(join(host.stateDirectory(atlas.id), "notes.txt"), "not ours");
  const result = await remove(host, atlas.id);
  expect(result.warnings).toHaveLength(1);
  expect(readdirSync(host.stateDirectory(atlas.id)).sort()).toEqual(["bot.json", "notes.txt"]);
  expect(host.store.get(atlas.id)).toBeNull();
});

it("never touches project files or project records", async () => {
  const host = await setup();
  host.put("host-project", "/projects/project/SOUL.md", "Project file");
  const { atlas } = await botWithHistory(host);
  const files = new Map(host.files);
  const projects = JSON.stringify(host.projects);
  await remove(host, atlas.id);
  expect(host.files).toEqual(files);
  expect(JSON.stringify(host.projects)).toBe(projects);
  for (const method of ["files.write", "files.mkdir", "projects.update", "projects.create"]) expect(host.harness.inspection.sdk.callsTo(method)).toEqual([]);
});

it("refuses while the bot or an inherited child conversation is running", async () => {
  const host = await setup();
  const { atlas, main } = await botWithHistory(host);
  thread(host, "child", { parentThreadId: main, runtime: running });
  await expect(remove(host, atlas.id)).rejects.toThrow("Atlas has running work in child");
  thread(host, "child", { parentThreadId: main });
  host.threads.set(main, { ...host.threads.get(main)!, hasPendingInteraction: true } as ReturnType<typeof makeThreadResponse>);
  await expect(remove(host, atlas.id)).rejects.toThrow(`running work in ${main}`);
  expect(host.store.require(atlas.id).mainThreadId).toBe(main);
  expect(host.store.owner(main)).toBe(atlas.id);
  expect(host.store.projectOwner("project")?.botId).toBe(atlas.id);
  expect(existsSync(host.stateDirectory(atlas.id))).toBe(true);
  host.threads.set(main, { ...host.threads.get(main)!, hasPendingInteraction: false } as ReturnType<typeof makeThreadResponse>);
  await expect(remove(host, atlas.id)).resolves.toMatchObject({ botId: atlas.id });
});

it("does not let an unfinished legacy migration recreate a deleted bot", async () => {
  const host = await setup();
  host.put("host-project", "/projects/project/bot.json", JSON.stringify({ version: 1, role: "Legacy", mainThreadId: null, awaitingMain: true }));
  thread(host, "legacy-thread");
  const [legacy] = (await list(host)).bots;
  expect(legacy?.legacyProjectId).toBe("project");
  // A history scan that keeps failing leaves the project unfinished.
  host.store.setState("legacy-snapshot", { ...host.store.state<object>("legacy-snapshot"), done: [] });
  let failScan = true;
  host.harness.inspection.sdk.stub("threads.list", async ({ projectId, archived = false, offset = 0, limit = 100 }: { projectId?: string; archived?: boolean; offset?: number; limit?: number } = {}) => {
    if (projectId && failScan) throw new Error("History unavailable");
    return [...host.threads.values()].filter((t) => (!projectId || t.projectId === projectId) && Boolean(t.archivedAt) === archived).slice(offset, offset + limit);
  });
  await remove(host, legacy!.id);
  failScan = false;
  expect((await list(host)).bots).toEqual([]);
  expect(host.store.owner("legacy-thread")).toBeNull();
});

it("keeps a deleted bot's legacy home out of work projects", async () => {
  const host = await backend([project(), project("home")]); hosts.push(host);
  const atlas = await host.create("Atlas", []);
  host.store.save({ ...host.store.require(atlas.id), legacyHomeProjectId: "home" });
  await remove(host, atlas.id);
  expect((await host.harness.behavior.callRpc("bots_list", null) as { projects: { id: string }[] }).projects.map((entry) => entry.id)).toEqual(["project"]);
  const beryl = await host.create("Beryl", []);
  await expect(role(host, beryl.id, "own", "home")).rejects.toThrow("not a legacy bot home");
});

it("does not let a concurrent legacy import resurrect the deleted bot", async () => {
  const host = await setup();
  host.put("host-project", "/projects/project/bot.json", JSON.stringify({ version: 1, role: "Legacy", mainThreadId: null, awaitingMain: true }));
  thread(host, "legacy-thread");
  const [legacy] = (await list(host)).bots;
  host.store.setState("legacy-snapshot", { ...host.store.state<object>("legacy-snapshot"), done: [] });
  let reached!: () => void, release!: () => void;
  const scanning = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.harness.inspection.sdk.stub("threads.list", async ({ projectId, archived = false, offset = 0, limit = 100 }: { projectId?: string; archived?: boolean; offset?: number; limit?: number } = {}) => {
    if (projectId === "project") { reached(); await gate; }
    return [...host.threads.values()].filter((t) => (!projectId || t.projectId === projectId) && Boolean(t.archivedAt) === archived).slice(offset, offset + limit);
  });
  const listing = list(host);
  await scanning;
  const deleting = remove(host, legacy!.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([listing, deleting]);
  expect((await list(host)).bots).toEqual([]);
});

it("keeps the deleted bot's Work tasks unchanged and labels their owner as deleted", async () => {
  const host = await setup();
  const { atlas } = await botWithHistory(host);
  const beryl = await host.create("Beryl", []);
  const task = async (bot: string, title: string) => JSON.parse((await host.harness.behavior.runCli(["task", "set", "--title", title, "--status", "waiting", "--next", "Pick a date", "--bot", bot, "--thread", "none", "--json"])).stdout!).task as { id: string };
  const owned = await task(atlas.id, "Decide the release date");
  const other = await task(beryl.id, "Other work");
  const before = await host.harness.behavior.callRpc("tasks_list", null) as { tasks: { id: string }[] };
  const result = await remove(host, atlas.id);
  expect(result.keptTaskIds).toEqual([owned.id]);
  const view = await host.harness.behavior.callRpc("tasks_list", null) as { tasks: { id: string }[]; bots: { id: string; name: string; mainThreadId: string | null }[] };
  expect(view.tasks).toEqual(before.tasks);
  expect(view.tasks.map((entry) => entry.id).sort()).toEqual([owned.id, other.id].sort());
  expect(view.bots.find((bot) => bot.id === atlas.id)).toMatchObject({ name: "Atlas (deleted)", mainThreadId: null });
  expect(view.bots.find((bot) => bot.id === beryl.id)).toMatchObject({ name: "Beryl" });
  expect((await host.harness.behavior.runCli(["task", "set", "--title", "New", "--status", "now", "--next", "N", "--bot", atlas.id, "--thread", "none"])).exitCode).toBe(1);
});

it("reports a missing bot", async () => {
  const host = await setup();
  await expect(remove(host, "bot_missing")).rejects.toThrow("Bot no longer exists");
});
