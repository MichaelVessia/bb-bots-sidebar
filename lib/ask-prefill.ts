import type { BotTask } from "../contract";

// A Work task's Ask action queues an unsent question for one conversation. The
// composer bridge mounted in that conversation writes it into the draft. Nothing
// is ever sent. Entries expire so an abandoned navigation cannot fill a draft later.
const PREFILL_TTL_MS = 60_000;
const pending = new Map<string, { text: string; at: number }>();
const listeners = new Set<() => void>();

export function queueAskPrefill(threadId: string, text: string) {
  pending.set(threadId, { text, at: Date.now() });
  for (const listener of listeners) listener();
}

export function takeAskPrefill(threadId: string): string | null {
  const entry = pending.get(threadId);
  pending.delete(threadId);
  return entry && Date.now() - entry.at <= PREFILL_TTL_MS ? entry.text : null;
}

export function subscribeAskPrefill(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function askQuestion(task: Pick<BotTask, "id" | "title">) {
  return `Please explain Work task ${task.id} ("${task.title}"): what exactly do you need me to decide or do, what are my options, and what do you recommend?`;
}
