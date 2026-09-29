import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { TASKS_CHANGED, type BotTask, type TaskBot, type TaskStatus, type rpcContract } from "../contract";
import { relativeTime } from "../lib/relative-time";
import { taskLinkLabel } from "../lib/task-links";
import { BotIcon } from "./bot-icon";
import { ConversationStatusIcon } from "./conversation-status-icon";

const SECTIONS: { status: TaskStatus; title: string; empty: string }[] = [
  { status: "now", title: "Now", empty: "No active tasks." },
  { status: "waiting", title: "Waiting on Michael", empty: "Nothing needs you." },
  { status: "done", title: "Done", empty: "No finished tasks yet." },
];
const DONE_SHOWN = 20;

// Task records are explicit data. Refresh on the plugin's change signal and on
// reconnection only; never poll or derive a status from thread activity.
export function useTasks() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{ tasks: BotTask[]; bots: TaskBot[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    rpc.call("tasks_list", null).then(
      (result) => { if (current === sequence.current) { setData(result); setError(null); } },
      (cause) => { if (current === sequence.current) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
  }, [rpc]);
  useEffect(() => { refresh(); return () => { sequence.current++; }; }, [refresh]);
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== "connected") refresh();
    previous.current = connection;
  }, [connection, refresh]);
  useRealtime(TASKS_CHANGED, refresh);
  return { data, error };
}

function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  return now;
}

function TaskCard({ task, bot, thread, now }: { task: BotTask; bot: TaskBot | undefined; thread: PluginSidebarThread | undefined; now: number }) {
  const navigate = useBbNavigate();
  const threadTitle = thread ? thread.title ?? thread.titleFallback ?? "Untitled conversation" : "Open thread";
  return <li className="work-task rounded-md border border-border px-3 py-2" data-task-id={task.id}>
    <div className="flex items-start gap-2">
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{task.title}</span>
      <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={new Date(task.updatedAt).toISOString()} title={new Date(task.updatedAt).toLocaleString()}>{relativeTime(task.updatedAt, now)}</time>
    </div>
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1">
        {bot ? <BotIcon avatar={bot.avatar} size={16} /> : null}
        <span className="truncate">{bot?.name ?? "Unknown bot"}</span>
      </span>
      {task.threadId ? <button type="button" className="work-thread-link flex min-w-0 items-center gap-1 rounded hover:text-foreground hover:underline" onClick={() => navigate.toThread(task.threadId!)}>
        {thread ? <ConversationStatusIcon thread={thread} /> : null}
        <span className="max-w-56 truncate">{threadTitle}</span>
      </button> : null}
      {task.links.map((link) => {
        const { kind, label } = taskLinkLabel(link);
        return <UrlLink key={link} href={link} className="work-external-link hover:text-foreground hover:underline" title={link}>{kind === "pr" ? "PR " : kind === "issue" ? "Issue " : ""}{label}</UrlLink>;
      })}
    </div>
    {task.status !== "done" && task.nextStep ? <p className="mt-1.5 whitespace-pre-wrap text-xs text-foreground"><span className="text-muted-foreground">Next: </span>{task.nextStep}</p> : null}
    {task.outcome ? <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground"><span>{task.status === "done" ? "Outcome: " : "Last: "}</span>{task.outcome}</p> : null}
  </li>;
}

export function WorkPanel() {
  const { data, error } = useTasks();
  const sidebar = experimental_useSidebarThreads();
  const now = useMinuteClock();
  const threads = useMemo(() => new Map(sidebar.threads.map((thread) => [thread.id, thread])), [sidebar.threads]);
  const bots = useMemo(() => new Map((data?.bots ?? []).map((bot) => [bot.id, bot])), [data]);
  // Right-panel tab (flush layout): the panel owns its padding and scrolling.
  return <div className="work-panel flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3">
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    {!data && !error ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : null}
    {data ? SECTIONS.map((section) => {
      const all = data.tasks.filter((task) => task.status === section.status);
      const shown = section.status === "done" ? all.slice(0, DONE_SHOWN) : all;
      return <section key={section.status} aria-labelledby={`work-${section.status}`} data-work-section={section.status}>
        <h2 id={`work-${section.status}`} className="mb-2 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {section.title}<span className={`tabular-nums font-normal ${section.status === "waiting" && all.length ? "text-primary" : ""}`}>{all.length}</span>
        </h2>
        {shown.length ? <ul className="space-y-2">{shown.map((task) => <TaskCard key={task.id} task={task} bot={bots.get(task.botId)} thread={task.threadId ? threads.get(task.threadId) : undefined} now={now} />)}</ul>
          : <p className="text-xs text-muted-foreground">{section.empty}</p>}
        {all.length > shown.length ? <p className="mt-2 text-xs text-muted-foreground">{all.length - shown.length} older Done tasks hidden. See bb bots task list --status done.</p> : null}
      </section>;
    }) : null}
    <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">Agents update tasks with <code>bb bots task set</code>. Thread status icons are live; task status changes only when a record is updated.</p>
  </div>;
}
