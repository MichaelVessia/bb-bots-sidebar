import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotMetadata } from "../contract";
import type { BotStore } from "./bot-store";
import { conversationRoots, orderConversations } from "./conversation-order";

export async function listBotConversations(bb: BbPluginApi, bot: BotMetadata, resolveOwner: (id: string, persist: boolean) => Promise<string | null>) {
  const rows: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await bb.sdk.threads.list({ archived: false, offset, limit: 100 });
    for (const row of page) {
      if (!row.archivedAt && !row.deletedAt && row.visibility !== "hidden" && await resolveOwner(row.id, false) === bot.id) rows.push(row);
    }
    if (page.length < 100) break;
  }
  const ordered = orderConversations(rows, bot.threadOrder);
  return { rows: ordered, roots: conversationRoots(ordered) };
}

type ThreadRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
export type BotStatus = "idle" | "working" | "waiting" | "error";

export function threadStatus(thread: ThreadRow): BotStatus {
  const runtime = thread.runtime.displayStatus;
  return thread.hasPendingInteraction || runtime === "waiting-for-host" || runtime === "host-reconnecting" ? "waiting"
    : ["active", "pending", "provisioning", "starting", "stopping"].includes(runtime) || Object.values(thread.activity ?? {}).some(count => count > 0) ? "working"
    : runtime === "error" || thread.queuedWork === "failed" ? "error" : "idle";
}

// Every live thread, hidden ones included, grouped by the bot that owns it
// directly or through its parent/source chain.
export async function liveThreadsByBot(bb: BbPluginApi, store: Pick<BotStore, "bindings">, resolveOwner: (id: string, persist: boolean) => Promise<string | null>, signal?: AbortSignal) {
  const threads: ThreadRow[] = [];
  for (let offset = 0; ; offset += 100) {
    signal?.throwIfAborted();
    const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, offset, limit: 100, signal });
    threads.push(...page);
    if (page.length < 100) break;
  }
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const direct = new Map(store.bindings().map(binding => [binding.threadId, binding.botId]));
  const result = new Map<string, ThreadRow[]>();
  for (const thread of threads) {
    if (thread.archivedAt || thread.deletedAt) continue;
    let id: string | null = thread.id;
    let owner: string | undefined;
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      owner = direct.get(id);
      if (owner) break;
      const ancestor = byId.get(id);
      if (!ancestor) { owner = await resolveOwner(id, false) ?? undefined; break; }
      id = ancestor.parentThreadId ?? ancestor.sourceThreadId;
    }
    if (!owner) continue;
    const rows = result.get(owner) ?? []; rows.push(thread); result.set(owner, rows);
  }
  return result;
}
