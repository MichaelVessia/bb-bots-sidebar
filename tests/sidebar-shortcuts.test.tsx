// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

// Mirrors BB's host contract: thread.next/previous/jump.N query these anchors
// in DOM order and click one. jsdom's `hidden` does not remove elements from
// querySelectorAll, matching the host's behavior.
function targets(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>("a[data-sidebar-thread-shortcut-target]"))
    .map((element) => ({ element, threadId: element.dataset.sidebarThreadId! }));
}
function step(container: HTMLElement, activeThreadId: string, delta: 1 | -1) {
  const list = targets(container);
  const index = list.findIndex((target) => target.threadId === activeThreadId);
  list[index === -1 ? (delta === 1 ? 0 : list.length - 1) : (index + delta + list.length) % list.length]!.element.click();
}

async function mount(activeThreadId: string) {
  const bots = [
    { ...bot, id: "one", name: "Bot one", mainThreadId: "one-first" },
    { ...bot, id: "two", name: "Bot two", mainThreadId: "two-first", order: 1 },
  ];
  const threads = [
    thread("one-first", 300), thread("one-second", 200),
    thread("two-first", 300), thread("two-second", 200),
    thread("chat", 100, { projectId: personalProjectId, environment: null }),
  ];
  const slot = renderSlot(app.threadLists[0]!, {
    activeThreadId, activeProjectId: "project", isCompactViewport: false,
    onNavigate: vi.fn(), searchQuery: "", Original: () => null,
  }, {
    sidebarThreads: {
      projects: [{ id: "project", name: "Project", isPersonal: false }, { id: personalProjectId, name: "Personal", isPersonal: true }],
      threads,
    },
    rpc: {
      bots_list: () => ({
        bots, sections: [], personalProjectId, hosts: [{ id: "host", name: "Local", connected: true }], projects: [{ id: "project", name: "Project" }], warnings: [],
        threadBindings: [
          { botId: "one", threadId: "one-first" }, { botId: "one", threadId: "one-second" },
          { botId: "two", threadId: "two-first" }, { botId: "two", threadId: "two-second" },
        ],
      }),
    },
  });
  await slot.findByText("Bot two");
  return slot;
}

it("makes each folded bot one shortcut target that opens its first conversation", async () => {
  const slot = await mount("chat");
  expect(targets(slot.container).map((target) => target.threadId)).toEqual(["one-first", "two-first", "chat"]);
  targets(slot.container)[1]!.element.click();
  expect(slot.inspection.sidebarActionCalls).toEqual([{ method: "open", threadId: "two-first", options: undefined }]);
});

it("continues next/previous from an active conversation inside a folded bot", async () => {
  const slot = await mount("one-second");
  expect(targets(slot.container).map((target) => target.threadId)).toEqual(["one-second", "two-first", "chat"]);
  step(slot.container, "one-second", 1);
  step(slot.container, "one-second", -1);
  expect(slot.inspection.sidebarActionCalls).toEqual([
    { method: "open", threadId: "two-first", options: undefined },
    { method: "open", threadId: "chat", options: { split: false } },
  ]);
});

it("uses the visible conversation rows of an expanded bot without a duplicate bot target", async () => {
  const slot = await mount("one-first");
  fireEvent.click(slot.getByRole("button", { name: "Expand conversations for Bot one" }));
  expect(targets(slot.container).map((target) => target.threadId)).toEqual(["one-first", "one-second", "two-first", "chat"]);
  step(slot.container, "one-first", 1);
  expect(slot.inspection.sidebarActionCalls).toEqual([{ method: "open", threadId: "one-second", options: { split: false } }]);
});
