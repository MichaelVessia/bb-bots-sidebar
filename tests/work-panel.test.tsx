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
    context: "", recommendation: "", options: [], askThreadId: null, acknowledgedAt: null, needsAcknowledgement: false,
    waitingOn: status === "waiting" ? "michael" : null, waitingFor: "",
    createdAt: NOW - 60_000, updatedAt: NOW - 5 * 60_000, updatedByThreadId: null, ...overrides,
  };
}
type StatusInput = { taskId: string; status: BotTask["status"]; waitingOn?: BotTask["waitingOn"]; waitingFor?: string; nextStep?: string; outcome?: string };
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

const column = (slot: ReturnType<typeof mount>["slot"], id: string) => slot.container.querySelector<HTMLElement>(`[data-work-column="${id}"]`)!;
const cardIn = (slot: ReturnType<typeof mount>["slot"], columnId: string, title: string) => within(column(slot, columnId)).queryByText(title)?.closest("li") ?? null;
// Records the server would return for a move, so tests follow the real column rules.
function mover(view: { tasks: BotTask[] }, calls: StatusInput[]) {
  return (input: StatusInput) => {
    calls.push(input);
    const index = view.tasks.findIndex((entry) => entry.id === input.taskId);
    const current = view.tasks[index]!;
    view.tasks[index] = { ...current, status: input.status, waitingOn: input.status === "waiting" ? input.waitingOn ?? "other" : null, waitingFor: input.waitingFor ?? "",
      ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}), ...(input.outcome !== undefined ? { outcome: input.outcome } : {}), needsAcknowledgement: false, acknowledgedAt: null };
    return view.tasks[index]!;
  };
}
function dataTransfer() {
  const data = new Map<string, string>();
  return { effectAllowed: "", dropEffect: "", setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "", get types() { return [...data.keys()]; } };
}

it("shows a board with Now, Waiting on Michael, Waiting on others, and Done, stacked as lanes in a narrow panel", async () => {
  const { slot } = mount([task("n", "now"), decision, task("o", "waiting", { title: "Vendor fix", waitingOn: "other", waitingFor: "Mosyle administrator" }), task("legacy", "waiting", { title: "Old waiting", waitingOn: null })]);
  await slot.findByText("Review Flo360 launch PRs");
  expect(Array.from(slot.container.querySelectorAll("[data-work-column]")).map((entry) => entry.getAttribute("data-work-column"))).toEqual(["now", "michael", "others", "done"]);
  expect(slot.container.querySelector(".work-board")?.getAttribute("data-layout")).toBe("lanes");
  expect(within(column(slot, "michael")).getByRole("heading").textContent).toBe("Waiting on Michael1");
  expect(cardIn(slot, "michael", "Review Flo360 launch PRs")!.textContent).toContain("approve PR #4417");
  expect(cardIn(slot, "michael", "Review Flo360 launch PRs")!.textContent).not.toContain("Michael:");
  expect(cardIn(slot, "others", "Vendor fix")!.textContent).toContain("Waiting on Mosyle administrator");
  expect(cardIn(slot, "others", "Old waiting")!.textContent).toContain("Waiting on owner not recorded");
  expect(column(slot, "done").textContent).toContain("No new results.");
});

it("uses side-by-side columns when the panel is wide", async () => {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(private callback: ResizeObserverCallback) {} observe() { this.callback([{ contentRect: { width: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  try {
    const { slot } = mount([task("n", "now")]);
    await slot.findByText("Task n");
    await waitFor(() => expect(slot.container.querySelector(".work-board")?.getAttribute("data-layout")).toBe("columns"));
  } finally { globalThis.ResizeObserver = original; }
});

it("expands a card to show outcome, context, options, links, owner thread, and actions", async () => {
  const { slot } = mount([{ ...decision, context: "Staging passed." }]);
  const toggle = await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Waiting on Michael\. Expand/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const detail = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(detail.textContent).toContain("What you need to decide or do");
  expect(detail.textContent).toContain("Approve after CI passes");
  expect(detail.textContent).toContain("Staging passed.");
  expect(within(detail).getByText("PR flo360#4417").closest("a")?.getAttribute("href")).toBe("https://github.com/acme/flo360/pull/4417");
  expect(within(within(detail).getByRole("button", { name: /Runner audit/ })).getByRole("img", { name: "Waiting for input" })).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "Ask Orchestrator to explain" })).toBeTruthy();
  expect(slot.container.textContent).not.toContain(bot.soul || "SOUL");
});

it("drags a card to another column with a visible drop target, saves without notes, and announces the result", async () => {
  const calls: StatusInput[] = [];
  const now = task("n", "now", { title: "Ship fix", nextStep: "" });
  const { slot, view } = mount([now, decision], undefined, (input) => mover(view, calls)(input));
  const card = (await slot.findByText("Ship fix")).closest("li")!;
  const transfer = dataTransfer();
  fireEvent.dragStart(card, { dataTransfer: transfer });
  expect(card.getAttribute("data-dragging")).toBe("true");
  fireEvent.dragOver(column(slot, "now"), { dataTransfer: transfer });
  expect(column(slot, "now").getAttribute("data-drop-target")).toBe("false");
  fireEvent.dragOver(column(slot, "done"), { dataTransfer: transfer });
  expect(column(slot, "done").getAttribute("data-drop-target")).toBe("true");
  expect(column(slot, "done").textContent).toContain("Drop to move to Done");
  fireEvent.dragOver(column(slot, "michael"), { dataTransfer: transfer });
  expect(column(slot, "michael").querySelector(".work-drop-hint")?.className).toContain("absolute");
  expect(column(slot, "done").getAttribute("data-drop-target")).toBe("false");
  fireEvent.dragOver(column(slot, "done"), { dataTransfer: transfer });
  fireEvent.drop(column(slot, "done"), { dataTransfer: transfer });
  await waitFor(() => expect(calls).toEqual([{ taskId: now.id, status: "done" }]));
  expect(await slot.findByText("Moved “Ship fix” to Done.")).toBeTruthy();
  // Michael's own Done needs no acknowledgement; it lands in the opened history.
  expect(within(column(slot, "done")).getByRole("button", { name: /History/, expanded: true })).toBeTruthy();
  expect(cardIn(slot, "done", "Ship fix")).not.toBeNull();
});

it("moves a card with Alt+Arrow keys and keeps focus on it", async () => {
  const calls: StatusInput[] = [];
  const { slot, view } = mount([task("n", "now", { title: "Ship fix" })], undefined, (input) => mover(view, calls)(input));
  const toggle = await slot.findByRole("button", { name: /Ship fix\. Now\. Expand/ });
  toggle.focus();
  fireEvent.keyDown(toggle, { key: "ArrowRight", altKey: true });
  await waitFor(() => expect(calls).toEqual([{ taskId: view.tasks[0]!.id, status: "waiting", waitingOn: "michael" }]));
  await waitFor(() => expect(cardIn(slot, "michael", "Ship fix")).not.toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: /Ship fix\. Waiting on Michael\. Expand/ })));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(calls.at(-1)).toEqual({ taskId: view.tasks[0]!.id, status: "waiting", waitingOn: "other" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(calls).toHaveLength(2);
});

it("moves a card with the Move menu and keeps a named other owner", async () => {
  const calls: StatusInput[] = [];
  const vendor = task("o", "waiting", { title: "Vendor fix", waitingOn: "agent", waitingFor: "Codex" });
  const { slot, view } = mount([vendor], undefined, (input) => mover(view, calls)(input));
  const trigger = await slot.findByRole("button", { name: /Move Vendor fix\. Now in Waiting on others/ });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await slot.findByRole("menu");
  expect(within(menu).getAllByRole("menuitem").map((item) => [item.textContent, item.hasAttribute("data-disabled")])).toEqual([["Now", false], ["Waiting on Michael", false], ["Waiting on others", true], ["Done", false]]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Now" }));
  await waitFor(() => expect(calls).toEqual([{ taskId: vendor.id, status: "now" }]));
});

it("rolls a card back and explains the error when a move fails", async () => {
  const now = task("n", "now", { title: "Ship fix" });
  const { slot } = mount([now], undefined, () => { throw new Error("Server unavailable."); });
  const card = (await slot.findByText("Ship fix")).closest("li")!;
  const transfer = dataTransfer();
  fireEvent.dragStart(card, { dataTransfer: transfer });
  fireEvent.drop(column(slot, "michael"), { dataTransfer: transfer });
  expect((await slot.findByRole("alert")).textContent).toBe("Could not move “Ship fix”: Server unavailable. It stayed in Now.");
  expect(cardIn(slot, "now", "Ship fix")).not.toBeNull();
  expect(cardIn(slot, "michael", "Ship fix")).toBeNull();
});

it("edits optional notes after a move, with empty notes allowed", async () => {
  const calls: StatusInput[] = [];
  const vendor = task("o", "waiting", { title: "Vendor fix", waitingOn: "other", waitingFor: "" , nextStep: "" });
  const { slot, view } = mount([vendor], undefined, (input) => mover(view, calls)(input));
  fireEvent.click(await slot.findByRole("button", { name: /Vendor fix\. Waiting on others\. Expand/ }));
  expect(slot.getByText("No next step recorded.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Edit notes" }));
  expect(document.activeElement).toBe(slot.getByLabelText("Next step (optional)"));
  const who = slot.getByLabelText("Who (optional)");
  fireEvent.change(who, { target: { value: "Mosyle administrator" } });
  expect(fireEvent.keyDown(who, { key: "Enter" })).toBe(false);
  fireEvent.click(slot.getByRole("button", { name: "Save notes" }));
  await waitFor(() => expect(calls).toEqual([{ taskId: vendor.id, status: "waiting", nextStep: "", waitingOn: "other", waitingFor: "Mosyle administrator" }]));
  expect(await slot.findByText("Saved notes for “Vendor fix”.")).toBeTruthy();
  expect(cardIn(slot, "others", "Vendor fix")!.textContent).toContain("Waiting on Mosyle administrator");
});

it("keeps new agent results in Done until acknowledged, with legacy results in history", async () => {
  const first = task("u1", "done", { title: "C4 draft ready", needsAcknowledgement: true, outcome: "Private C4 draft saved", links: ["https://github.com/acme/app/pull/9"], threadId: "worker" });
  const second = task("u2", "done", { title: "Second result", needsAcknowledgement: true });
  const legacy = task("old", "done", { title: "Legacy result" });
  const calls: unknown[] = [];
  const { slot, view } = mount([first, second, legacy], (input) => {
    calls.push(input);
    const index = view.tasks.findIndex((entry) => entry.id === input.taskId);
    view.tasks[index] = { ...view.tasks[index]!, acknowledgedAt: input.acknowledged ? NOW : null, needsAcknowledgement: !input.acknowledged };
    return view.tasks[index]!;
  });
  const done = column(slot, (await slot.findByText("C4 draft ready"), "done"));
  expect(within(done).getByRole("heading").textContent).toContain("2");
  const row = cardIn(slot, "done", "C4 draft ready")!;
  expect(row.textContent).toContain("New result");
  expect(row.textContent).toContain("Private C4 draft saved");
  expect(within(done).getByRole("button", { name: /History/ }).textContent).toContain("1");
  expect(cardIn(slot, "done", "Legacy result")).toBeNull();
  fireEvent.click(within(row).getByRole("button", { name: "Acknowledge" }));
  await waitFor(() => expect(calls).toEqual([{ taskId: first.id, acknowledged: true }]));
  await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("button", { name: /Second result\. Done, new result\. Expand/ })));
  expect(within(column(slot, "done")).getByRole("button", { name: /History/ }).textContent).toContain("2");
});

it("lets Michael read the full outcome before acknowledging from the expanded card", async () => {
  const unread = task("u", "done", { title: "Long result", needsAcknowledgement: true, outcome: "Line one\nLine two with the full outcome" });
  const { slot } = mount([unread], (input) => ({ ...unread, acknowledgedAt: input.acknowledged ? NOW : null, needsAcknowledgement: false }));
  fireEvent.click(await slot.findByRole("button", { name: /Long result\. Done, new result\. Expand/ }));
  expect(cardIn(slot, "done", "Long result")!.querySelector(".work-card-detail")!.textContent).toContain("Line two with the full outcome");
});

it("drafts an unsent Ask question for the explaining conversation without sending anything", async () => {
  const { slot } = mount([decision]);
  fireEvent.click(await slot.findByRole("button", { name: /Review Flo360 launch PRs\. Waiting on Michael\. Expand/ }));
  fireEvent.click(slot.getByRole("button", { name: "Ask Orchestrator to explain" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "orch" }]);
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["tasks_list"]);
  expect(takeAskPrefill("orch")).toBe(askQuestion(decision));
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

it("refreshes on the task change signal only, without polling", async () => {
  const { slot, view } = mount([]);
  await slot.findByText("No active work.");
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
