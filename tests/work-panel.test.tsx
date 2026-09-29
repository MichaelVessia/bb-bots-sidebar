// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BotTask } from "../contract";
import { TASKS_CHANGED } from "../contract";
import { askQuestion, queueAskPrefill, takeAskPrefill } from "../lib/ask-prefill";
import { relativeTime } from "../lib/relative-time";
import { bot, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);
const NOW = Date.now();
const orchestrator = { id: "bot-orchestrator", name: "Orchestrator", role: "Coordinator", avatar: bot.avatar };
function task(id: string, status: BotTask["status"], overrides: Partial<BotTask> = {}): BotTask {
  return {
    id: `task_${id.padEnd(32, "0")}`, title: `Task ${id}`, status, botId: bot.id, threadId: null, links: [],
    nextStep: status === "done" ? "" : `Next ${id}`, outcome: status === "done" ? `Outcome ${id}` : "",
    context: "", recommendation: "", options: [], askThreadId: null, acknowledgedAt: null,
    waitingOn: status === "waiting" ? "michael" : null, waitingFor: "",
    createdAt: NOW - 60_000, updatedAt: NOW - 5 * 60_000, updatedByThreadId: null, ...overrides,
  };
}
type StatusInput = { taskId: string; status: BotTask["status"]; waitingOn?: BotTask["waitingOn"]; waitingFor?: string; outcome?: string };
function mount(tasks: BotTask[], acknowledge?: (input: { taskId: string; acknowledged: boolean }) => BotTask, setStatus?: (input: StatusInput) => BotTask) {
  const panel = app.threadPanelActions.find((entry) => entry.id === "work")!;
  const view = { tasks, bots: [{ id: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar }, orchestrator], threadBots: { worker: bot.id, orch: orchestrator.id } };
  const threads = [thread("worker", 1, { title: "Runner audit", hasPendingInteraction: true }), thread("orch", 1, { title: "Orchestrator main" })];
  const slot = renderSlot(panel, { threadId: "current", params: null }, {
    rpc: { tasks_list: () => view, task_acknowledge: (input: unknown) => acknowledge!(input as { taskId: string; acknowledged: boolean }),
      task_set_status: (input: unknown) => setStatus!(input as StatusInput) },
    sidebarThreads: { projects: [], threads },
  });
  return { slot, view };
}
const decision = task("flo", "waiting", {
  title: "Review Flo360 launch PRs", threadId: "worker", askThreadId: "orch", nextStep: "Michael: approve PR #4417",
  recommendation: "Approve after CI passes", options: ["Approve now", "Wait for QA"], links: ["https://github.com/acme/flo360/pull/4417"], outcome: "Descriptions cleaned",
});

it("offers Work as a right-panel tab plus an invisible thread-composer bridge, not a nav page", () => {
  expect(app.threadLists.map((entry) => entry.id)).toEqual(["bot-projects"]);
  expect(app.navPanels).toEqual([]);
  for (const actions of [app.threadPanelActions, app.newThreadPanelActions]) {
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: "work", title: "Work", layout: "flush" });
  }
  expect(app.newThreadPanelActions[0]!.component).toBe(app.threadPanelActions[0]!.component);
  expect(app.composerCustomizations).toMatchObject([{ id: "work-ask", scopes: ["thread"], banners: [{ id: "work-ask-prefill", chrome: "bare" }] }]);
});

it("lists Waiting first with the requested action, owner, and age; hides empty sections; collapses Done", async () => {
  const { slot } = mount([decision, task("d", "done")]);
  const waiting = await slot.findByRole("region", { name: /Waiting on Michael/ });
  expect(slot.container.querySelector("[data-work-section]")?.getAttribute("data-work-section")).toBe("waiting");
  expect(slot.queryByRole("region", { name: /^Now/ })).toBeNull();
  const row = within(waiting).getByText("Review Flo360 launch PRs").closest("li")!;
  expect(row.textContent).toContain("approve PR #4417");
  expect(row.textContent).not.toContain("Michael:");
  expect(within(row).getByText("5m ago")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: /open Runner audit/ }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "worker" }]);
  const done = slot.getByRole("button", { name: /Done/ });
  expect(done.getAttribute("aria-expanded")).toBe("false");
  expect(done.textContent).toContain("1");
  expect(slot.queryByText("Task d")).toBeNull();
});

it("opens a focused detail with the request, supplied guidance, honest gaps, sources, and owner thread, then returns focus", async () => {
  const { slot } = mount([decision]);
  const open = await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Waiting on Michael\. Open details/ });
  fireEvent.click(open);
  const heading = slot.getByRole("heading", { name: "Review Flo360 launch PRs", level: 2 });
  expect(document.activeElement).toBe(heading);
  const detail = heading.closest("article")!;
  expect(detail.textContent).toContain("What you need to decide or do");
  expect(detail.textContent).toContain("approve PR #4417");
  expect(detail.textContent).toContain("Approve after CI passes");
  expect(within(detail).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Approve now", "Wait for QA", "PR flo360#4417"]);
  expect(detail.textContent).toContain("No context was recorded.");
  expect(detail.textContent).toContain("Last result");
  expect(within(detail).getByText("PR flo360#4417").closest("a")?.getAttribute("href")).toBe("https://github.com/acme/flo360/pull/4417");
  expect(within(within(detail).getByRole("button", { name: /Runner audit/ })).getByRole("img", { name: "Waiting for input" })).toBeTruthy();
  fireEvent.keyDown(detail, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: /Review Flo360 launch PRs\. Waiting/ })));
});

it("says when a decision has no options or recommendation", async () => {
  const { slot } = mount([task("bare", "waiting")]);
  fireEvent.click(await slot.findByRole("button", { name: /Task bare\. Waiting/ }));
  expect(slot.getByText("No options or recommendation were recorded for this decision.")).toBeTruthy();
  expect(slot.getByText("No PR or issue link was recorded.")).toBeTruthy();
});

it("opens the Waiting heading as a focused list with a back path", async () => {
  const { slot } = mount([decision, task("n", "now")]);
  fireEvent.click(await slot.findByRole("button", { name: "Waiting on Michael, 1 task. Show only these" }));
  expect(slot.getByRole("heading", { name: /Waiting on Michael 1/ })).toBeTruthy();
  expect(slot.queryByText("Task n")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Review Flo360 launch PRs\. Waiting/ }));
  fireEvent.click(slot.getByRole("button", { name: "Waiting on Michael" }));
  fireEvent.click(slot.getByRole("button", { name: "Work" }));
  expect(await slot.findByText("Task n")).toBeTruthy();
});

it("drafts an unsent Ask question for the explaining conversation without sending anything", async () => {
  const { slot } = mount([decision]);
  fireEvent.click(await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Waiting/ }));
  fireEvent.click(slot.getByRole("button", { name: "Ask Orchestrator to explain" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "orch" }]);
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["tasks_list"]);
  expect(takeAskPrefill("orch")).toBe(askQuestion(decision));
  expect(askQuestion(decision)).toContain(decision.id);
});

it("fills only the matching thread draft, appending to existing text", async () => {
  const bridge = app.composerCustomizations[0]!.banners![0]!.component;
  queueAskPrefill("other", "Not for this thread");
  queueAskPrefill("orch", "Explain task_x");
  const slot = renderSlot({ component: bridge }, {}, { composer: { text: "Draft", scope: { kind: "thread", threadId: "orch" } } });
  await waitFor(() => expect(slot.inspection.composer.text).toBe("Draft\n\nExplain task_x"));
  expect(slot.inspection.composer.submits).toEqual([]);
  expect(slot.container.textContent).toBe("");
  expect(takeAskPrefill("other")).toBe("Not for this thread");
});

it("acknowledges read Done results and keeps them in acknowledged history", async () => {
  const done = task("d", "done");
  const calls: unknown[] = [];
  const { slot, view } = mount([done], (input) => { calls.push(input); view.tasks[0] = { ...done, acknowledgedAt: input.acknowledged ? NOW : null }; return view.tasks[0]!; });
  fireEvent.click(await slot.findByRole("button", { name: /Done/ }));
  fireEvent.click(slot.getByRole("button", { name: "Acknowledge" }));
  await slot.findByText("All results acknowledged.");
  expect(calls).toEqual([{ taskId: done.id, acknowledged: true }]);
  fireEvent.click(slot.getByRole("button", { name: "Show acknowledged (1)" }));
  fireEvent.click(slot.getByRole("button", { name: "Return to Done" }));
  expect(calls).toEqual([{ taskId: done.id, acknowledged: true }, { taskId: done.id, acknowledged: false }]);
});

it("separates Waiting on Michael from Waiting on others and never presents an unrecorded owner as Michael", async () => {
  const { slot } = mount([
    decision,
    task("chrome", "waiting", { title: "Stop Chrome prompt", waitingOn: "other", waitingFor: "Mosyle administrator" }),
    task("legacy", "waiting", { title: "Old waiting task", waitingOn: null }),
    task("bot", "waiting", { title: "Agent task", waitingOn: "agent" }),
  ]);
  const mine = await slot.findByRole("region", { name: /Waiting on Michael/ });
  expect(within(mine).getAllByRole("listitem")).toHaveLength(1);
  const others = slot.getByRole("region", { name: /Waiting on others/ });
  expect(others.textContent).toContain("Waiting on Mosyle administrator");
  expect(others.textContent).toContain("Waiting on owner not recorded");
  expect(others.textContent).toContain("Waiting on an agent");
  expect(slot.getByRole("button", { name: /Old waiting task\. Waiting on owner not recorded\. Open details/ })).toBeTruthy();
});

it("changes status from the row menu with the keyboard and keeps focus on the moved row", async () => {
  const other = task("chrome", "waiting", { title: "Stop Chrome prompt", waitingOn: "other", waitingFor: "Mosyle administrator" });
  const calls: StatusInput[] = [];
  const { slot, view } = mount([other], undefined, (input) => { calls.push(input); view.tasks[0] = { ...other, waitingOn: "michael", waitingFor: "" }; return view.tasks[0]!; });
  const trigger = await slot.findByRole("button", { name: /Change status of Stop Chrome prompt\. Now: Waiting on Mosyle administrator/ });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await slot.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Now", "Waiting on Michael", "Waiting on someone else…", "Waiting on an agent…", "Done…"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Waiting on Michael" }));
  await waitFor(() => expect(calls).toEqual([{ taskId: other.id, status: "waiting", waitingOn: "michael" }]));
  const moved = await slot.findByRole("button", { name: /Stop Chrome prompt\. Waiting on Michael\. Open details/ });
  await waitFor(() => expect(document.activeElement).toBe(moved));
});

it("edits status and waiting owner in the detail with explicit Save, validation, and a named owner", async () => {
  const calls: StatusInput[] = [];
  const { slot, view } = mount([decision], undefined, (input) => { calls.push(input); view.tasks[0] = { ...decision, status: input.status, waitingOn: input.waitingOn ?? null, waitingFor: input.waitingFor ?? "" }; return view.tasks[0]!; });
  fireEvent.click(await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Waiting on Michael/ }));
  const save = slot.getByRole("button", { name: "Save status" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(slot.getByLabelText("Waiting on"), { target: { value: "other" } });
  const who = slot.getByLabelText("Who (optional)");
  fireEvent.change(who, { target: { value: "flo360 reviewers" } });
  expect(fireEvent.keyDown(who, { key: "Enter" })).toBe(false);
  expect(calls).toEqual([]);
  fireEvent.click(save);
  await waitFor(() => expect(calls).toEqual([{ taskId: decision.id, status: "waiting", waitingOn: "other", waitingFor: "flo360 reviewers" }]));
  // Save returns to the Work list with focus on the task in its new section.
  const others = await slot.findByRole("region", { name: /Waiting on others/ });
  const moved = within(others).getByRole("button", { name: /Review Flo360 launch PRs\. Waiting on flo360 reviewers\. Open details/ });
  await waitFor(() => expect(document.activeElement).toBe(moved));
  expect(slot.queryByRole("button", { name: "Save status" })).toBeNull();
  fireEvent.click(moved);
  fireEvent.change(slot.getByLabelText("Progress"), { target: { value: "now" } });
  fireEvent.click(slot.getByRole("button", { name: "Reset" }));
  expect((slot.getByLabelText("Progress") as HTMLSelectElement).value).toBe("waiting");
  fireEvent.change(slot.getByLabelText("Progress"), { target: { value: "done" } });
  fireEvent.change(slot.getByLabelText("Outcome"), { target: { value: " " } });
  fireEvent.click(slot.getByRole("button", { name: "Save status" }));
  expect(await slot.findByText("Add the outcome before marking this Done.")).toBeTruthy();
  expect(calls).toHaveLength(1);
  expect(slot.getByRole("button", { name: "Save status" })).toBeTruthy();
});

it("returns to the list with Done expanded and focused after saving a task as Done", async () => {
  const { slot, view } = mount([decision], undefined, (input) => { view.tasks[0] = { ...decision, status: "done", waitingOn: null, outcome: input.outcome! }; return view.tasks[0]!; });
  fireEvent.click(await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Waiting on Michael/ }));
  fireEvent.change(slot.getByLabelText("Progress"), { target: { value: "done" } });
  fireEvent.change(slot.getByLabelText("Outcome"), { target: { value: "Approved" } });
  fireEvent.click(slot.getByRole("button", { name: "Save status" }));
  const row = await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Done\. Open details/ });
  expect(slot.getByRole("button", { name: /Done/, expanded: true })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(row));
});

it("opens the detail editor preset from a row menu choice that needs more detail", async () => {
  const { slot } = mount([decision]);
  fireEvent.keyDown(await slot.findByRole("button", { name: /Change status of Review Flo360/ }), { key: "ArrowDown" });
  fireEvent.click(await slot.findByRole("menuitem", { name: "Waiting on someone else…" }));
  expect((slot.getByLabelText("Waiting on") as HTMLSelectElement).value).toBe("other");
  await waitFor(() => expect(document.activeElement).toBe(slot.getByLabelText("Who (optional)")));
});

it("refreshes on the task change signal only, without polling", async () => {
  const { slot, view } = mount([]);
  await slot.findByText(/No tasks yet/);
  view.tasks.push(task("new", "now"));
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["tasks_list"]);
  await slot.emitRealtime(TASKS_CHANGED, {});
  await slot.findByText("Task new");
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["tasks_list", "tasks_list"]);
  expect(slot.container.textContent).not.toContain(bot.soul || "SOUL");
});

it("formats relative update times", () => {
  expect(relativeTime(NOW, NOW)).toBe("just now");
  expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
});
