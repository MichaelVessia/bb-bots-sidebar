import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { TASKS_CHANGED, type BotTask, type TaskBot, type TaskStatus, type WaitingOn, type rpcContract } from "../contract";
import { usePortalScopeProps } from "../lib/portal-scope";
import { askQuestion, queueAskPrefill } from "../lib/ask-prefill";
import { relativeTime } from "../lib/relative-time";
import { taskLinkLabel } from "../lib/task-links";
import { Button } from "./ui/button";
import { BotIcon } from "./bot-icon";
import { ConversationStatusIcon } from "./conversation-status-icon";

type TaskView = { tasks: BotTask[]; bots: TaskBot[]; threadBots: Record<string, string> };
type StatusChange = { status: TaskStatus; waitingOn?: WaitingOn; waitingFor?: string; outcome?: string };
type Preset = Pick<StatusChange, "status" | "waitingOn">;
type View = { kind: "list" } | { kind: "waiting" } | { kind: "task"; taskId: string; from: "list" | "waiting"; preset?: Preset };
const WAITING_LABEL: Record<WaitingOn, string> = { michael: "Michael", other: "someone else", agent: "an agent" };
const MENU_ITEM_CLASS = "bot-menu-item cursor-default select-none rounded-sm px-2 py-1.5 text-xs outline-none data-[disabled]:opacity-40";
const SELECT_CLASS = "h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground";

// An unrecorded owner stays unrecorded: it is never presented as Michael.
export function waitingLabel(task: Pick<BotTask, "waitingOn" | "waitingFor">) {
  if (!task.waitingOn) return "owner not recorded";
  return task.waitingOn === "michael" ? "Michael" : task.waitingFor || WAITING_LABEL[task.waitingOn];
}
export function statusLabel(task: BotTask) {
  return task.status === "now" ? "Now" : task.status === "done" ? "Done" : `Waiting on ${waitingLabel(task)}`;
}
const waitsOnMichael = (task: BotTask) => task.status === "waiting" && task.waitingOn === "michael";
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
    return rpc.call("tasks_list", null).then(
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
const requestText = (task: BotTask) => waitsOnMichael(task) ? task.nextStep.replace(/^michael\s*[:,-]\s*/i, "") : task.nextStep;
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

function StatusMenu({ task, onChange, onEdit }: { task: BotTask; onChange: (change: StatusChange) => void; onEdit: (preset: Preset) => void }) {
  const portalScope = usePortalScopeProps();
  const items: { label: string; disabled?: boolean; select: () => void }[] = [
    { label: "Now", disabled: task.status === "now", select: () => onChange({ status: "now" }) },
    { label: "Waiting on Michael", disabled: waitsOnMichael(task), select: () => onChange({ status: "waiting", waitingOn: "michael" }) },
    { label: "Waiting on someone else…", select: () => onEdit({ status: "waiting", waitingOn: "other" }) },
    { label: "Waiting on an agent…", select: () => onEdit({ status: "waiting", waitingOn: "agent" }) },
    { label: "Done…", disabled: task.status === "done", select: () => onEdit({ status: "done" }) },
  ];
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><Button type="button" variant="ghost" size="sm" className="work-status-menu h-6 shrink-0 gap-1 px-1.5 text-[11px]" aria-label={`Change status of ${task.title}. Now: ${statusLabel(task)}`}>
      Status<svg aria-hidden="true" width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 5 5 5-5" /></svg>
    </Button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} align="end" sideOffset={4} className="z-50 min-w-52 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
      {items.map((item) => <DropdownMenu.Item key={item.label} disabled={item.disabled} className={MENU_ITEM_CLASS} onSelect={item.select}>{item.label}</DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

type RowProps = { task: BotTask; bot: TaskBot | undefined; thread: PluginSidebarThread | undefined; now: number; onOpen: () => void; onChange: (change: StatusChange) => void; onEdit: (preset: Preset) => void; onAcknowledge?: () => void; acknowledgeLabel?: string; showLinks?: boolean };
function TaskRow({ task, bot, thread, now, onOpen, onChange, onEdit, onAcknowledge, acknowledgeLabel, showLinks }: RowProps) {
  return <li className="work-task border-b border-border/60 last:border-b-0" data-task-id={task.id}>
    <button type="button" className="work-task-open block w-full rounded-md px-2 pt-2 pb-1 text-left hover:bg-state-hover" data-focus-key={task.id} aria-label={`${task.title}. ${statusLabel(task)}. Open details`} onClick={onOpen}>
      <span className="block text-[13px] font-medium leading-5 text-foreground">{task.title}</span>
      <span className="mt-0.5 line-clamp-2 block text-xs leading-[18px] text-foreground/85">{primaryText(task)}</span>
    </button>
    {showLinks && task.links.length ? <p className="work-row-links flex flex-wrap gap-x-3 gap-y-0.5 px-2 pb-1 text-[11px]">{task.links.map((link) => {
      const { kind, label } = taskLinkLabel(link);
      return <UrlLink key={link} href={link} className="work-external-link text-foreground/85 underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground" title={link}>{kind === "pr" ? "PR " : kind === "issue" ? "Issue " : ""}{label}</UrlLink>;
    })}</p> : null}
    {task.status === "waiting" && !waitsOnMichael(task) ? <p className="work-waiting-on px-2 pb-1 text-[11px] text-foreground/85">Waiting on <span className={task.waitingOn ? "font-medium" : "italic text-muted-foreground"}>{waitingLabel(task)}</span></p> : null}
    <div className="flex min-w-0 items-center gap-2 px-2 pb-2 text-[11px] text-muted-foreground">
      <OwnerLink task={task} bot={bot} thread={thread} />
      <span aria-hidden="true">·</span>
      <Age at={task.updatedAt} now={now} />
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {onAcknowledge ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onAcknowledge}>{acknowledgeLabel}</Button> : null}
        <StatusMenu task={task} onChange={onChange} onEdit={onEdit} />
      </span>
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

// Manual progress and waiting-owner control. Native selects keep full keyboard
// support; Save is explicit and Enter never submits.
function StatusEditor({ task, preset, onSave }: { task: BotTask; preset?: Preset; onSave: (change: StatusChange) => Promise<void> }) {
  const initial = { status: preset?.status ?? task.status, waitingOn: (preset?.waitingOn ?? task.waitingOn ?? "") as WaitingOn | "" };
  const [status, setStatus] = useState<TaskStatus>(initial.status);
  const [waitingOn, setWaitingOn] = useState<WaitingOn | "">(initial.waitingOn);
  const [waitingFor, setWaitingFor] = useState(task.waitingFor);
  const [outcome, setOutcome] = useState(task.outcome);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `work-status-${task.id}`;
  const needsName = status === "waiting" && Boolean(waitingOn) && waitingOn !== "michael";
  const dirty = status !== task.status || (status === "waiting" && (waitingOn !== (task.waitingOn ?? "") || (needsName && waitingFor.trim() !== task.waitingFor))) || (status === "done" && outcome.trim() !== task.outcome);
  const focusTarget = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (preset) focusTarget.current?.focus(); }, [preset]);
  async function save() {
    if (status === "waiting" && !waitingOn) { setError("Choose who this task is waiting on."); return; }
    if (status === "done" && !outcome.trim()) { setError("Add the outcome before marking this Done."); return; }
    setPending(true); setError(null);
    try {
      await onSave({ status, ...(status === "waiting" ? { waitingOn: waitingOn as WaitingOn, waitingFor: needsName ? waitingFor.trim() : "" } : {}), ...(status === "done" ? { outcome: outcome.trim() } : {}) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setPending(false); }
  }
  return <Field label="Status">
    <form className="work-status-editor space-y-2" onSubmit={(event) => event.preventDefault()} onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-status`}>Progress
          <select id={`${id}-status`} className={SELECT_CLASS} value={status} disabled={pending} onChange={(event) => { setStatus(event.target.value as TaskStatus); setError(null); }}>
            <option value="now">Now</option><option value="waiting">Waiting</option><option value="done">Done</option>
          </select>
        </label>
        {status === "waiting" ? <label className="space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-on`}>Waiting on
          <select id={`${id}-on`} className={SELECT_CLASS} value={waitingOn} disabled={pending} onChange={(event) => { setWaitingOn(event.target.value as WaitingOn | ""); setError(null); }}>
            {!waitingOn ? <option value="" disabled>Not recorded — choose</option> : null}
            <option value="michael">Michael</option><option value="other">Someone else</option><option value="agent">An agent</option>
          </select>
        </label> : null}
      </div>
      {needsName ? <label className="block space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-who`}>Who (optional)
        <input ref={focusTarget} id={`${id}-who`} className={SELECT_CLASS} maxLength={120} value={waitingFor} disabled={pending} placeholder="e.g. Mosyle administrator" onChange={(event) => setWaitingFor(event.target.value)} />
      </label> : null}
      {status === "done" ? <label className="block space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-outcome`}>Outcome
        <textarea ref={focusTarget} id={`${id}-outcome`} className="min-h-16 w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground" maxLength={1000} value={outcome} disabled={pending} onChange={(event) => setOutcome(event.target.value)} />
      </label> : null}
      {error ? <p role="alert" className="text-[11px] text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={!dirty || pending} onClick={() => void save()}>{pending ? "Saving…" : "Save status"}</Button>
        {dirty && !pending ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setStatus(task.status); setWaitingOn(task.waitingOn ?? ""); setWaitingFor(task.waitingFor); setOutcome(task.outcome); setError(null); }}>Reset</Button> : null}
      </div>
    </form>
  </Field>;
}

function TaskDetail({ task, bots, threadBots, threads, now, backLabel, preset, onBack, onAcknowledge, onSetStatus }: {
  task: BotTask; bots: Map<string, TaskBot>; threadBots: Record<string, string>; threads: Map<string, PluginSidebarThread>; now: number;
  backLabel: string; preset?: Preset; onBack: () => void; onAcknowledge: (acknowledged: boolean) => void; onSetStatus: (change: StatusChange) => Promise<void>;
}) {
  const navigate = useBbNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!preset) heading.current?.focus(); }, [task.id, preset]);
  const bot = bots.get(task.botId);
  const thread = task.threadId ? threads.get(task.threadId) : undefined;
  // Existing records may predate askThreadId; the latest writer can explain them.
  const askThreadId = task.askThreadId ?? task.updatedByThreadId ?? task.threadId;
  const askBot = askThreadId ? bots.get(threadBots[askThreadId] ?? "") : undefined;
  const askName = askBot?.name ?? threadTitle(askThreadId ? threads.get(askThreadId) : undefined);
  const noGuidance = waitsOnMichael(task) && !task.recommendation && !task.options.length;
  return <article className="work-detail space-y-4" aria-labelledby={`work-detail-${task.id}`}>
    <button type="button" className="work-back -ml-1 flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 5-5 5 5 5" /></svg>
      {backLabel}
    </button>
    <header className="space-y-1">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className={task.status === "waiting" ? "font-medium text-foreground" : ""}>{statusLabel(task)}</span><span aria-hidden="true">·</span>Updated <Age at={task.updatedAt} now={now} /></p>
      <h2 id={`work-detail-${task.id}`} ref={heading} tabIndex={-1} className="text-sm font-semibold leading-5 text-foreground outline-none">{task.title}</h2>
    </header>
    <Field label={waitsOnMichael(task) ? "What you need to decide or do" : task.status === "waiting" ? `Next action · waiting on ${waitingLabel(task)}` : task.status === "now" ? "Next step" : "Outcome"}>
      <p className="whitespace-pre-wrap text-[13px] leading-5">{primaryText(task)}</p>
    </Field>
    <StatusEditor key={`${task.id}:${task.updatedAt}:${preset?.status ?? ""}:${preset?.waitingOn ?? ""}`} task={task} preset={preset} onSave={onSetStatus} />
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
      {task.status === "done" ? <Button type="button" variant={task.needsAcknowledgement ? "default" : "ghost"} size="sm" onClick={() => onAcknowledge(!task.acknowledgedAt)}>{task.acknowledgedAt ? "Mark unread" : "Acknowledge"}</Button> : null}
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
    const target = root.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
    if (!target) return; // A moved row may render after the refresh.
    restoreFocus.current = null;
    target.focus();
  }, [view, data]);
  // Acknowledging keeps the keyboard in place: focus the next unread result, else
  // the Done toggle, once the refreshed list has moved the task into history.
  const acknowledge = (task: BotTask, acknowledged: boolean, then?: () => void) => {
    setActionError(null);
    const unread = (data?.tasks ?? []).filter((entry) => entry.status === "done" && entry.needsAcknowledgement);
    const next = unread[unread.findIndex((entry) => entry.id === task.id) + 1] ?? unread.find((entry) => entry.id !== task.id);
    rpc.call("task_acknowledge", { taskId: task.id, acknowledged }).then(async () => {
      await refresh();
      restoreFocus.current = acknowledged ? next?.id ?? "done-toggle" : task.id;
      then?.();
    }, (cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };
  const setStatus = async (taskId: string, change: StatusChange) => {
    await rpc.call("task_set_status", { taskId, ...change });
    // Wait for the moved task so the list renders it in its new section before focus.
    await refresh();
  };
  // Quick menu changes keep the list; focus follows the row into its new section.
  const quickStatus = (task: BotTask, change: StatusChange) => {
    setActionError(null); restoreFocus.current = task.id;
    setStatus(task.id, change).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };
  const open = (task: BotTask, from: "list" | "waiting", preset?: Preset) => { restoreFocus.current = task.id; setView({ kind: "task", taskId: task.id, from, ...(preset ? { preset } : {}) }); };
  const back = () => setView(view.kind === "task" && view.from === "waiting" ? { kind: "waiting" } : { kind: "list" });
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && view.kind !== "list") { event.stopPropagation(); if (view.kind === "waiting") restoreFocus.current = "waiting-heading"; back(); } };
  const row = (task: BotTask, from: "list" | "waiting", acknowledgeLabel?: string, showLinks = false) => <TaskRow key={task.id} task={task} bot={bots.get(task.botId)} thread={task.threadId ? threads.get(task.threadId) : undefined} now={now} onOpen={() => open(task, from)}
    onChange={(change) => quickStatus(task, change)} onEdit={(preset) => open(task, from, preset)}
    showLinks={showLinks} {...(acknowledgeLabel ? { acknowledgeLabel, onAcknowledge: () => acknowledge(task, !task.acknowledgedAt, () => setView({ kind: "list" })) } : {})} />;

  let body: ReactNode = null;
  if (data) {
    const waiting = data.tasks.filter(waitsOnMichael);
    const others = data.tasks.filter((task) => task.status === "waiting" && !waitsOnMichael(task));
    const active = data.tasks.filter((task) => task.status === "now");
    const unread = data.tasks.filter((task) => task.status === "done" && task.needsAcknowledgement);
    // Done history: legacy results (never acknowledged, never unread) and acknowledged ones.
    const done = data.tasks.filter((task) => task.status === "done" && !task.needsAcknowledgement && !task.acknowledgedAt);
    const acknowledged = data.tasks.filter((task) => task.status === "done" && !task.needsAcknowledgement && task.acknowledgedAt);
    const task = view.kind === "task" ? data.tasks.find((entry) => entry.id === view.taskId) : undefined;
    if (view.kind === "task") {
      body = task ? <TaskDetail task={task} bots={bots} threadBots={data.threadBots} threads={threads} now={now} backLabel={view.from === "waiting" ? "Waiting on Michael" : "Work"} preset={view.preset} onBack={back} onAcknowledge={(value) => acknowledge(task, value, () => setView({ kind: "list" }))}
        onSetStatus={async (change) => {
          await setStatus(task.id, change);
          // Back to the list: focus follows the task into its new section.
          if (change.status === "done") setDoneOpen(true);
          restoreFocus.current = task.id; setView({ kind: "list" });
        }} />
        : <div className="space-y-2"><Missing>This task no longer exists.</Missing><Button type="button" variant="outline" size="sm" onClick={back}>Back</Button></div>;
    } else if (view.kind === "waiting") {
      body = <section aria-labelledby="work-waiting-focused" className="space-y-2">
        <button type="button" className="work-back -ml-1 flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => { restoreFocus.current = "waiting-heading"; setView({ kind: "list" }); }}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 5-5 5 5 5" /></svg>Work
        </button>
        <h2 id="work-waiting-focused" className="text-sm font-semibold text-foreground">Waiting on Michael <span className="work-count rounded-full bg-state-active px-1.5 tabular-nums text-foreground">{waiting.length}</span></h2>
        {waiting.length ? <ul>{waiting.map((entry) => row(entry, "waiting"))}</ul> : <Missing>Nothing is waiting on you.</Missing>}
      </section>;
    } else if (!waiting.length && !unread.length && !others.length && !active.length && !done.length && !acknowledged.length) {
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
        {unread.length ? <section aria-labelledby="work-unread" data-work-section="unread">
          <h2 id="work-unread" className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Needs acknowledgement<span className="work-count rounded-full bg-state-active px-1.5 tabular-nums font-semibold text-foreground">{unread.length}</span></h2>
          <ul>{unread.map((entry) => row(entry, "list", "Acknowledge", true))}</ul>
        </section> : null}
        {active.length ? <section aria-labelledby="work-now" data-work-section="now">
          <h2 id="work-now" className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Now<span className="tabular-nums font-normal">{active.length}</span></h2>
          <ul>{active.map((entry) => row(entry, "list"))}</ul>
        </section> : null}
        {others.length ? <section aria-labelledby="work-others" data-work-section="others">
          <h2 id="work-others" className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Waiting on others<span className="tabular-nums font-normal">{others.length}</span></h2>
          <ul>{others.map((entry) => row(entry, "list"))}</ul>
        </section> : null}
        {done.length || acknowledged.length ? <section aria-labelledby="work-done" data-work-section="done">
          <h2 id="work-done"><button type="button" aria-expanded={doneOpen} aria-controls="work-done-list" data-focus-key="done-toggle" className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setDoneOpen((value) => !value)}>
            <svg className={doneOpen ? "rotate-90" : ""} aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m8 5 5 5-5 5" /></svg>
            Done<span className="tabular-nums font-normal">{done.length + acknowledged.length}</span>
          </button></h2>
          <div id="work-done-list" hidden={!doneOpen}>{doneOpen ? <>
            {done.length ? <ul>{done.slice(0, DONE_SHOWN).map((entry) => row(entry, "list", "Acknowledge"))}</ul> : null}
            {done.length > DONE_SHOWN ? <p className="px-2 text-xs text-muted-foreground">{done.length - DONE_SHOWN} older results hidden. See bb bots task list --status done.</p> : null}
            {acknowledged.length ? <div className="mt-1">
              <button type="button" aria-expanded={historyOpen} aria-controls="work-acknowledged" className="rounded-sm px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setHistoryOpen((value) => !value)}>{historyOpen ? "Hide" : "Show"} acknowledged ({acknowledged.length})</button>
              <ul id="work-acknowledged" hidden={!historyOpen}>{historyOpen ? acknowledged.slice(0, DONE_SHOWN).map((entry) => row(entry, "list", "Mark unread")) : null}</ul>
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
