import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { TASKS_CHANGED, type BotTask, type TaskBot, type TaskStatus, type rpcContract } from "../contract";
import { askQuestion, queueAskPrefill } from "../lib/ask-prefill";
import { relativeTime } from "../lib/relative-time";
import { taskLinkLabel } from "../lib/task-links";
import { Button } from "./ui/button";
import { BotIcon } from "./bot-icon";
import { ConversationStatusIcon } from "./conversation-status-icon";

type TaskView = { tasks: BotTask[]; bots: TaskBot[]; threadBots: Record<string, string> };
type View = { kind: "list" } | { kind: "waiting" } | { kind: "task"; taskId: string; from: "list" | "waiting" };
const STATUS_LABEL: Record<TaskStatus, string> = { now: "Now", waiting: "Waiting on Michael", done: "Done" };
const DONE_SHOWN = 20;

// Task records are explicit data. Refresh on the plugin's change signal and on
// reconnection only; never poll or derive a status from thread activity.
export function useTasks() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<TaskView | null>(null);
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
  return { data, error, rpc, refresh };
}

function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  return now;
}

// The section already says who is waiting; drop a leading "Michael:" address.
const requestText = (task: BotTask) => task.nextStep.replace(/^michael\s*[:,-]\s*/i, "");
const primaryText = (task: BotTask) => task.status === "done" ? task.outcome : requestText(task);
const threadTitle = (thread: PluginSidebarThread | undefined) => thread ? thread.title ?? thread.titleFallback ?? "Untitled conversation" : "Open conversation";

function Age({ at, now }: { at: number; now: number }) {
  return <time className="shrink-0 tabular-nums" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{relativeTime(at, now)}</time>;
}

function OwnerLink({ task, bot, thread }: { task: BotTask; bot: TaskBot | undefined; thread: PluginSidebarThread | undefined }) {
  const navigate = useBbNavigate();
  const content = <>{bot ? <BotIcon avatar={bot.avatar} size={14} /> : null}<span className="truncate">{bot?.name ?? "Unknown bot"}</span></>;
  return task.threadId
    ? <button type="button" className="work-owner-link flex min-w-0 items-center gap-1 rounded-sm hover:text-foreground hover:underline" title={`Open ${threadTitle(thread)}`} aria-label={`${bot?.name ?? "Unknown bot"}: open ${threadTitle(thread)}`} onClick={() => navigate.toThread(task.threadId!)}>{content}</button>
    : <span className="flex min-w-0 items-center gap-1">{content}</span>;
}

type RowProps = { task: BotTask; bot: TaskBot | undefined; thread: PluginSidebarThread | undefined; now: number; onOpen: () => void; onAcknowledge?: () => void; acknowledgeLabel?: string };
function TaskRow({ task, bot, thread, now, onOpen, onAcknowledge, acknowledgeLabel }: RowProps) {
  return <li className="work-task border-b border-border/60 last:border-b-0" data-task-id={task.id}>
    <button type="button" className="work-task-open block w-full rounded-md px-2 pt-2 pb-1 text-left hover:bg-state-hover" data-focus-key={task.id} aria-label={`${task.title}. ${STATUS_LABEL[task.status]}. Open details`} onClick={onOpen}>
      <span className="block text-[13px] font-medium leading-5 text-foreground">{task.title}</span>
      <span className="mt-0.5 line-clamp-2 block text-xs leading-[18px] text-foreground/85">{primaryText(task)}</span>
    </button>
    <div className="flex min-w-0 items-center gap-2 px-2 pb-2 text-[11px] text-muted-foreground">
      <OwnerLink task={task} bot={bot} thread={thread} />
      <span aria-hidden="true">·</span>
      <Age at={task.updatedAt} now={now} />
      {onAcknowledge ? <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[11px]" onClick={onAcknowledge}>{acknowledgeLabel}</Button> : null}
    </div>
  </li>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <section className="space-y-1">
    <h3 className="text-[11px] font-medium text-muted-foreground">{label}</h3>
    <div className="text-xs leading-5 text-foreground">{children}</div>
  </section>;
}

function Missing({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function TaskDetail({ task, bots, threadBots, threads, now, backLabel, onBack, onAcknowledge }: {
  task: BotTask; bots: Map<string, TaskBot>; threadBots: Record<string, string>; threads: Map<string, PluginSidebarThread>; now: number;
  backLabel: string; onBack: () => void; onAcknowledge: (acknowledged: boolean) => void;
}) {
  const navigate = useBbNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [task.id]);
  const bot = bots.get(task.botId);
  const thread = task.threadId ? threads.get(task.threadId) : undefined;
  // Existing records may predate askThreadId; the latest writer can explain them.
  const askThreadId = task.askThreadId ?? task.updatedByThreadId ?? task.threadId;
  const askBot = askThreadId ? bots.get(threadBots[askThreadId] ?? "") : undefined;
  const askName = askBot?.name ?? threadTitle(askThreadId ? threads.get(askThreadId) : undefined);
  const noGuidance = task.status === "waiting" && !task.recommendation && !task.options.length;
  return <article className="work-detail space-y-4" aria-labelledby={`work-detail-${task.id}`}>
    <button type="button" className="work-back -ml-1 flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 5-5 5 5 5" /></svg>
      {backLabel}
    </button>
    <header className="space-y-1">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className={task.status === "waiting" ? "font-medium text-primary" : ""}>{STATUS_LABEL[task.status]}</span><span aria-hidden="true">·</span>Updated <Age at={task.updatedAt} now={now} /></p>
      <h2 id={`work-detail-${task.id}`} ref={heading} tabIndex={-1} className="text-sm font-semibold leading-5 text-foreground outline-none">{task.title}</h2>
    </header>
    <Field label={task.status === "waiting" ? "What you need to decide or do" : task.status === "now" ? "Next step" : "Outcome"}>
      <p className="whitespace-pre-wrap text-[13px] leading-5">{primaryText(task)}</p>
    </Field>
    {task.recommendation ? <Field label="Recommendation"><p className="whitespace-pre-wrap">{task.recommendation}</p></Field> : null}
    {task.options.length ? <Field label="Options"><ol className="list-decimal space-y-1 pl-4">{task.options.map((option) => <li key={option}>{option}</li>)}</ol></Field> : null}
    {noGuidance ? <Missing>No options or recommendation were recorded for this decision.</Missing> : null}
    <Field label="Context">{task.context ? <p className="whitespace-pre-wrap">{task.context}</p> : <Missing>No context was recorded.</Missing>}</Field>
    {task.status !== "done" && task.outcome ? <Field label="Last result"><p className="whitespace-pre-wrap">{task.outcome}</p></Field> : null}
    <Field label="Sources">
      {task.links.length ? <ul className="space-y-1">{task.links.map((link) => {
        const { kind, label } = taskLinkLabel(link);
        return <li key={link}><UrlLink href={link} className="work-external-link underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground" title={link}>{kind === "pr" ? "PR " : kind === "issue" ? "Issue " : ""}{label}</UrlLink></li>;
      })}</ul> : <Missing>No PR or issue link was recorded.</Missing>}
    </Field>
    <Field label="Owner">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex items-center gap-1">{bot ? <BotIcon avatar={bot.avatar} size={16} /> : null}{bot?.name ?? "Unknown bot"}</span>
        {task.threadId ? <button type="button" className="work-thread-link flex min-w-0 items-center gap-1 rounded-sm" onClick={() => navigate.toThread(task.threadId!)}>
          {thread ? <ConversationStatusIcon thread={thread} /> : null}<span className="truncate underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground">{threadTitle(thread)}</span>
        </button> : <Missing>No conversation is linked.</Missing>}
      </div>
    </Field>
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {askThreadId ? <Button type="button" variant="outline" size="sm" className="work-ask" onClick={() => { queueAskPrefill(askThreadId, askQuestion(task)); navigate.toThread(askThreadId); }}>Ask {askName} to explain</Button> : null}
      {task.status === "done" ? <Button type="button" variant="ghost" size="sm" onClick={() => onAcknowledge(!task.acknowledgedAt)}>{task.acknowledgedAt ? "Return to Done" : "Acknowledge"}</Button> : null}
    </div>
    {askThreadId ? <p className="text-[11px] text-muted-foreground">Ask opens {askName}'s conversation with an unsent question about this task. You can edit it before sending.</p> : null}
  </article>;
}

export function WorkPanel() {
  const { data, error, rpc, refresh } = useTasks();
  const sidebar = experimental_useSidebarThreads();
  const now = useMinuteClock();
  const [view, setView] = useState<View>({ kind: "list" });
  const [doneOpen, setDoneOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const threads = useMemo(() => new Map(sidebar.threads.map((thread) => [thread.id, thread])), [sidebar.threads]);
  const bots = useMemo(() => new Map((data?.bots ?? []).map((bot) => [bot.id, bot])), [data]);
  useEffect(() => {
    // Return keyboard focus to the row or heading that opened the detail view.
    const key = restoreFocus.current;
    if (view.kind === "task" || !key) return;
    restoreFocus.current = null;
    root.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus();
  }, [view]);
  const acknowledge = (taskId: string, acknowledged: boolean) => {
    setActionError(null);
    rpc.call("task_acknowledge", { taskId, acknowledged }).then(refresh, (cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };
  const open = (task: BotTask, from: "list" | "waiting") => { restoreFocus.current = task.id; setView({ kind: "task", taskId: task.id, from }); };
  const back = () => setView(view.kind === "task" && view.from === "waiting" ? { kind: "waiting" } : { kind: "list" });
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && view.kind !== "list") { event.stopPropagation(); if (view.kind === "waiting") restoreFocus.current = "waiting-heading"; back(); } };
  const row = (task: BotTask, from: "list" | "waiting", acknowledgeLabel?: string) => <TaskRow key={task.id} task={task} bot={bots.get(task.botId)} thread={task.threadId ? threads.get(task.threadId) : undefined} now={now} onOpen={() => open(task, from)}
    {...(acknowledgeLabel ? { acknowledgeLabel, onAcknowledge: () => acknowledge(task.id, !task.acknowledgedAt) } : {})} />;

  let body: ReactNode = null;
  if (data) {
    const waiting = data.tasks.filter((task) => task.status === "waiting");
    const active = data.tasks.filter((task) => task.status === "now");
    const done = data.tasks.filter((task) => task.status === "done" && !task.acknowledgedAt);
    const acknowledged = data.tasks.filter((task) => task.status === "done" && task.acknowledgedAt);
    const task = view.kind === "task" ? data.tasks.find((entry) => entry.id === view.taskId) : undefined;
    if (view.kind === "task") {
      body = task ? <TaskDetail task={task} bots={bots} threadBots={data.threadBots} threads={threads} now={now} backLabel={view.from === "waiting" ? "Waiting on Michael" : "Work"} onBack={back} onAcknowledge={(value) => acknowledge(task.id, value)} />
        : <div className="space-y-2"><Missing>This task no longer exists.</Missing><Button type="button" variant="outline" size="sm" onClick={back}>Back</Button></div>;
    } else if (view.kind === "waiting") {
      body = <section aria-labelledby="work-waiting-focused" className="space-y-2">
        <button type="button" className="work-back -ml-1 flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => { restoreFocus.current = "waiting-heading"; setView({ kind: "list" }); }}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 5-5 5 5 5" /></svg>Work
        </button>
        <h2 id="work-waiting-focused" className="text-sm font-semibold text-foreground">Waiting on Michael <span className="work-count rounded-full bg-state-active px-1.5 tabular-nums text-foreground">{waiting.length}</span></h2>
        {waiting.length ? <ul>{waiting.map((entry) => row(entry, "waiting"))}</ul> : <Missing>Nothing is waiting on you.</Missing>}
      </section>;
    } else if (!waiting.length && !active.length && !done.length && !acknowledged.length) {
      body = <Missing>No tasks yet. Agents add them with <code>bb bots task set</code>.</Missing>;
    } else {
      body = <>
        {waiting.length ? <section aria-labelledby="work-waiting" data-work-section="waiting">
          <h2 id="work-waiting" className="mb-1"><button type="button" data-focus-key="waiting-heading" aria-label={`Waiting on Michael, ${waiting.length} ${waiting.length === 1 ? "task" : "tasks"}. Show only these`} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setView({ kind: "waiting" })}>
            Waiting on Michael<span className="work-count rounded-full bg-state-active px-1.5 tabular-nums font-semibold text-foreground">{waiting.length}</span>
            <svg className="ml-auto" aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m8 5 5 5-5 5" /></svg>
          </button></h2>
          <ul>{waiting.map((entry) => row(entry, "list"))}</ul>
        </section> : null}
        {active.length ? <section aria-labelledby="work-now" data-work-section="now">
          <h2 id="work-now" className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Now<span className="tabular-nums font-normal">{active.length}</span></h2>
          <ul>{active.map((entry) => row(entry, "list"))}</ul>
        </section> : null}
        {done.length || acknowledged.length ? <section aria-labelledby="work-done" data-work-section="done">
          <h2 id="work-done"><button type="button" aria-expanded={doneOpen} aria-controls="work-done-list" className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setDoneOpen((value) => !value)}>
            <svg className={doneOpen ? "rotate-90" : ""} aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m8 5 5 5-5 5" /></svg>
            Done<span className="tabular-nums font-normal">{done.length}</span>
          </button></h2>
          <div id="work-done-list" hidden={!doneOpen}>{doneOpen ? <>
            {done.length ? <ul>{done.slice(0, DONE_SHOWN).map((entry) => row(entry, "list", "Acknowledge"))}</ul> : <p className="px-2 py-1 text-xs text-muted-foreground">All results acknowledged.</p>}
            {done.length > DONE_SHOWN ? <p className="px-2 text-xs text-muted-foreground">{done.length - DONE_SHOWN} older results hidden. See bb bots task list --status done.</p> : null}
            {acknowledged.length ? <div className="mt-1">
              <button type="button" aria-expanded={historyOpen} aria-controls="work-acknowledged" className="rounded-sm px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setHistoryOpen((value) => !value)}>{historyOpen ? "Hide" : "Show"} acknowledged ({acknowledged.length})</button>
              <ul id="work-acknowledged" hidden={!historyOpen}>{historyOpen ? acknowledged.slice(0, DONE_SHOWN).map((entry) => row(entry, "list", "Return to Done")) : null}</ul>
            </div> : null}
          </> : null}</div>
        </section> : null}
      </>;
    }
  }
  // Right-panel tab (flush layout): the panel owns its padding and scrolling.
  return <div ref={root} className="work-panel flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3" onKeyDown={onKeyDown}>
    {error || actionError ? <p role="alert" className="text-xs text-destructive">{actionError ?? error}</p> : null}
    {!data && !error ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : null}
    {body}
  </div>;
}
