// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { bot, personalProjectId, thread } from "./fixtures";

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

async function mount(deleteBot: () => unknown) {
  const atlas = { ...bot, id: "atlas", name: "Atlas", mainThreadId: "main", linkedProjectIds: ["project", "other"] };
  let bots = [atlas];
  const slot = renderSlot(app.threadLists[0]!, {
    activeThreadId: null, activeProjectId: null, isCompactViewport: false,
    onNavigate: vi.fn(), searchQuery: "", Original: () => null,
  }, {
    sidebarThreads: {
      projects: [{ id: "project", name: "Shared project", isPersonal: false }, { id: "other", name: "Other project", isPersonal: false }],
      threads: [thread("main", 100), thread("child", 90, { parentThreadId: "main" })],
    },
    rpc: {
      bots_list: () => ({ bots, sections: [], personalProjectId, hosts: [{ id: "host", name: "Local", connected: true }], projects: [{ id: "project", name: "Shared project" }, { id: "other", name: "Other project" }], warnings: [], threadBindings: bots.map((entry) => ({ botId: entry.id, threadId: "main" })), projectOwners: bots.map((entry) => ({ botId: entry.id, projectId: "project" })) }),
      bot_delete: () => { const result = deleteBot(); bots = []; return result; },
    },
  });
  await slot.findByText("Atlas");
  fireEvent.contextMenu(slot.getByText("Atlas"));
  fireEvent.click(await slot.findByRole("menuitem", { name: "Delete bot…" }));
  const dialog = await slot.findByRole("dialog", { name: "Delete bot" });
  return { slot, dialog };
}
const result = { botId: "atlas", name: "Atlas", detachedConversationIds: ["main"], releasedProjectIds: ["project"], leftProjectIds: ["other"], keptTaskIds: [], warnings: [] };
const deleteCalls = (slot: Awaited<ReturnType<typeof mount>>["slot"]) => slot.inspection.rpcCalls.filter((call) => call.method === "bot_delete");

it("explains what stays and what goes, and deletes only after the exact name is typed", async () => {
  const { slot, dialog } = await mount(() => result);
  expect(dialog.textContent).toContain("Its SOUL.md, MEMORY.md, and settings are deleted.");
  expect(dialog.textContent).toContain("Its 2 conversations stay in BB and move to Chats.");
  expect(dialog.textContent).toContain("It releases ownership of Shared project.");
  expect(dialog.textContent).toContain("It leaves Other project.");
  expect(dialog.textContent).toContain("Its Work tasks stay in Work, with the owner shown as deleted.");
  expect(dialog.textContent).toContain("Project files do not change.");
  const input = within(dialog).getByRole("textbox", { name: "Bot name to confirm deletion" });
  const button = within(dialog).getByRole("button", { name: "Delete bot" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  for (const wrong of ["atlas", "Atlas ", "Atl"]) {
    fireEvent.change(input, { target: { value: wrong } });
    expect(button.disabled).toBe(true);
  }
  fireEvent.change(input, { target: { value: "Atlas" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(deleteCalls(slot)).toEqual([]);
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Delete bot" })).toBeNull());
  expect(deleteCalls(slot)).toEqual([{ method: "bot_delete", input: { botId: "atlas" } }]);
  await waitFor(() => expect(slot.queryByText("Atlas")).toBeNull());
  expect(await slot.findByText("Conversation main")).toBeTruthy();
});

it("keeps the dialog open and shows the server refusal for running work", async () => {
  const { slot, dialog } = await mount(() => { throw new Error("Atlas has running work in main. Stop it or let it finish, then delete the bot."); });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Bot name to confirm deletion" }), { target: { value: "Atlas" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete bot" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Atlas has running work in main");
  expect(slot.getByRole("dialog", { name: "Delete bot" })).toBeTruthy();
  expect(slot.container.querySelector('[data-bot-drop-target="atlas"]')).not.toBeNull();
});

it("cancels without deleting", async () => {
  const { slot, dialog } = await mount(() => result);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog", { name: "Delete bot" })).toBeNull());
  expect(deleteCalls(slot)).toEqual([]);
});
