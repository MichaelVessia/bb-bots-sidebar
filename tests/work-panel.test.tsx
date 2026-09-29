// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BotTask } from "../contract";
import { TASKS_CHANGED } from "../contract";
import { relativeTime } from "../lib/relative-time";
import { bot, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);
const NOW = Date.now();
function task(id: string, status: BotTask["status"], overrides: Partial<BotTask> = {}): BotTask {
  return { id: `task_${id.padEnd(32, "0")}`, title: `Task ${id}`, status, botId: bot.id, threadId: null, links: [], nextStep: status === "done" ? "" : `Next ${id}`, outcome: status === "done" ? `Outcome ${id}` : "", createdAt: NOW - 60_000, updatedAt: NOW - 5 * 60_000, updatedByThreadId: null, ...overrides };
}
function mount(tasks: BotTask[], threads = [thread("worker", 1, { title: "Runner audit", hasPendingInteraction: true })]) {
  const panel = app.threadPanelActions.find((entry) => entry.id === "work")!;
  const view = { tasks, bots: [{ id: bot.id, name: bot.name, role: bot.role, avatar: bot.avatar }] };
  const slot = renderSlot(panel, { threadId: "current", params: null }, { rpc: { tasks_list: () => view }, sidebarThreads: { projects: [], threads } });
  return { slot, view, panel };
}

it("offers Work as a right-panel tab for threads and the New thread screen, not a nav page", () => {
  expect(app.threadLists.map((entry) => entry.id)).toEqual(["bot-projects"]);
  expect(app.navPanels).toEqual([]);
  for (const actions of [app.threadPanelActions, app.newThreadPanelActions]) {
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: "work", title: "Work", layout: "flush" });
    expect(actions[0]!.run).toBeUndefined();
  }
  expect(app.newThreadPanelActions[0]!.component).toBe(app.threadPanelActions[0]!.component);
});

it("groups explicit task records into Now, Waiting on Michael, and Done with owner, links, update time, and next step", async () => {
  const { slot } = mount([
    task("a", "now", { threadId: "worker", links: ["https://github.com/acme/ci/pull/130", "https://linear.app/acme/issue/SRE-867/x"], outcome: "Staging passed" }),
    task("b", "waiting", { nextStep: "Approve the prod deploy" }),
    task("c", "done"),
  ]);
  const now = await slot.findByRole("region", { name: /^Now/ });
  const card = within(now).getByText("Task a").closest("li")!;
  expect(within(card).getByText(bot.name)).toBeTruthy();
  expect(within(card).getByText("5m ago")).toBeTruthy();
  expect(card.textContent).toContain("Next: Next a");
  expect(card.textContent).toContain("Last: Staging passed");
  expect(within(card).getByText("PR ci#130").closest("a")?.getAttribute("href")).toBe("https://github.com/acme/ci/pull/130");
  expect(within(card).getByText("Issue SRE-867")).toBeTruthy();
  // Live thread status comes from BB's thread state; the task status does not change.
  const threadLink = within(card).getByRole("button", { name: /Runner audit/ });
  expect(within(threadLink).getByRole("img", { name: "Waiting for input" })).toBeTruthy();
  fireEvent.click(threadLink);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "worker" }]);
  const waiting = slot.getByRole("region", { name: /^Waiting on Michael/ });
  expect(waiting.textContent).toContain("Approve the prod deploy");
  const done = slot.getByRole("region", { name: /^Done/ });
  expect(done.textContent).toContain("Outcome: Outcome c");
  expect(done.textContent).not.toContain("Next:");
});

it("shows empty states, bounds Done, and never renders private bot state", async () => {
  const { slot } = mount(Array.from({ length: 23 }, (_, i) => task(`d${i}`, "done")));
  await slot.findByText("Task d0");
  expect(slot.getByText("No active tasks.")).toBeTruthy();
  expect(slot.getByText("Nothing needs you.")).toBeTruthy();
  expect(within(slot.getByRole("region", { name: /^Done/ })).getAllByRole("listitem")).toHaveLength(20);
  expect(slot.getByText(/3 older Done tasks hidden/)).toBeTruthy();
  expect(slot.container.textContent).not.toContain(bot.soul || "SOUL");
});

it("refreshes on the task change signal only, without polling", async () => {
  const { slot, view } = mount([]);
  await slot.findByText("No active tasks.");
  view.tasks.push(task("new", "now"));
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["tasks_list"]);
  await slot.emitRealtime(TASKS_CHANGED, {});
  await slot.findByText("Task new");
  expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["tasks_list", "tasks_list"]);
});

it("keeps the Waiting count visible in the panel content and scrolls inside the tab", async () => {
  const { slot } = mount([task("w1", "waiting"), task("w2", "waiting"), task("n", "now")]);
  const heading = await slot.findByRole("heading", { name: /Waiting on Michael/ });
  expect(heading.textContent).toBe("Waiting on Michael2");
  expect(heading.querySelector(".text-primary")?.textContent).toBe("2");
  expect(slot.container.querySelector(".work-panel")?.className).toContain("overflow-y-auto");
});

it("formats relative update times", () => {
  expect(relativeTime(NOW, NOW)).toBe("just now");
  expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
});
