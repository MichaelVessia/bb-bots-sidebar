import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { UrlLink, experimental_useSidebarThreads, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { TASKS_CHANGED, type BotTask, type TaskBot, type TaskStatus, type WaitingOn, type rpcContract } from "../contract";
import { usePortalScopeProps } from "../lib/portal-scope";
import { askQuestion, queueAskPrefill } from "../lib/ask-prefill";
import { relativeTime } from "../lib/relative-time";
import { taskLinkLabel, withThreadLabels, type TaskLinkKind } from "../lib/task-links";
import { Button } from "./ui/button";
import { BotIcon } from "./bot-icon";
import { ConversationStatusIcon } from "./conversation-status-icon";

type TaskView = { tasks: BotTask[]; bots: TaskBot[]; threadBots: Record<string, string>; archivedThreadIds: string[] };
type Change = { status: TaskStatus; waitingOn?: WaitingOn; waitingFor?: string; nextStep?: string; outcome?: string };
export type ColumnId = "now" | "michael" | "others" | "done";
export const COLUMNS: { id: ColumnId; title: string; empty: string }[] = [
  { id: "now", title: "Now", empty: "No active work." },
  { id: "michael", title: "Waiting on Michael", empty: "Nothing needs you." },
  { id: "others", title: "Waiting on others", empty: "Nothing is waiting on others." },
  { id: "done", title: "Done", empty: "No new results." },
];
const WAITING_LABEL: Record<WaitingOn, string> = { michael: "Michael", other: "someone else", agent: "an agent" };
const MENU_ITEM_CLASS = "bot-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none data-[disabled]:opacity-40 pointer-coarse:min-h-9";
const FIELD_CLASS = "w-full rounded-md border border-input bg-background px-2 text-xs text-foreground";
const DRAG_TYPE = "application/x-bb-work-task";
// Below this width the right panel stacks the columns as lanes.
const COLUMN_LAYOUT_MIN_WIDTH = 720;
const HISTORY_SHOWN = 20;

// An unrecorded owner stays unrecorded: it is never presented as Michael.
export function waitingLabel(task: Pick<BotTask, "waitingOn" | "waitingFor">) {
  if (!task.waitingOn) return "owner not recorded";
  return task.waitingOn === "michael" ? "Michael" : task.waitingFor || WAITING_LABEL[task.waitingOn];
}
export function columnOf(task: Pick<BotTask, "status" | "waitingOn">): ColumnId {
  if (task.status === "now") return "now";
  if (task.status === "done") return "done";
  return task.waitingOn === "michael" ? "michael" : "others";
}
// A move needs no notes. Waiting on others keeps an existing non-Michael owner.
export function moveChange(task: BotTask, column: ColumnId): Change {
  if (column === "now") return { status: "now" };
  if (column === "done") return { status: "done" };
  if (column === "michael") return { status: "waiting", waitingOn: "michael" };
  return task.status === "waiting" && task.waitingOn && task.waitingOn !== "michael" ? { status: "waiting", waitingOn: task.waitingOn } : { status: "waiting", waitingOn: "other" };
}
const columnTitle = (column: ColumnId) => COLUMNS.find((entry) => entry.id === column)!.title;

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

function usePanelWidth(element: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = element.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
// The column already says who is waiting; drop a leading "Michael:" address.
const requestText = (task: BotTask) => columnOf(task) === "michael" ? task.nextStep.replace(/^michael\s*[:,-]\s*/i, "") : task.nextStep;
const primaryText = (task: BotTask) => task.status === "done" ? task.outcome : requestText(task);
const threadTitle = (thread: PluginSidebarThread | undefined) => thread ? thread.title ?? thread.titleFallback ?? "Untitled conversation" : "Open conversation";

function Age({ at, now }: { at: number; now: number }) {
  return <time className="shrink-0 tabular-nums" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{relativeTime(at, now)}</time>;
}

function Chevron({ direction }: { direction: "right" | "down" }) {
  return <svg aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">{direction === "down" ? <path d="m5 8 5 5 5-5" /> : <path d="m8 5 5 5-5 5" />}</svg>;
}

// Status names the state and who holds the next action, in a few words.
type Tone = "active" | "you" | "waiting" | "new" | "done";
export function cardStatus(task: BotTask, column: ColumnId): { text: string; tone: Tone } {
  if (column === "now") return { text: "In progress", tone: "active" };
  if (column === "michael") return { text: "Needs you", tone: "you" };
  if (column === "others") return { text: task.waitingOn ? `Waiting on ${waitingLabel(task)}` : "Waiting, owner not recorded", tone: "waiting" };
  return task.needsAcknowledgement ? { text: "New result", tone: "new" } : { text: "Done", tone: "done" };
}

const ICON_PROPS = { "aria-hidden": true, width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", className: "shrink-0" } as const;
function LinkIcon({ kind }: { kind: TaskLinkKind }) {
  if (kind === "pr") return <svg {...ICON_PROPS}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="12.5" r="1.5" /><path d="M4.5 5v6M11.5 11V6.5A2 2 0 0 0 9.5 4.5H7m1.5-1.5L7 4.5 8.5 6" /></svg>;
  if (kind === "issue") return <svg {...ICON_PROPS}><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1" fill="currentColor" /></svg>;
  return <svg {...ICON_PROPS}><path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" /></svg>;
}
const ExternalIcon = () => <svg {...ICON_PROPS} width={10} height={10}><path d="M6 3h7v7M13 3 5 11" /></svg>;
const ThreadIcon = () => <svg {...ICON_PROPS}><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5V11h.5" /></svg>;

// PR and proof links open outside BB: outlined, with an external arrow.
const EXTERNAL_CHIP_CLASS = "work-external-link inline-flex h-6 min-w-0 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] font-medium text-foreground hover:bg-state-hover pointer-coarse:h-9 pointer-coarse:px-2.5";
// Conversations open inside BB: filled, with a thread icon and live status.
const THREAD_CHIP_CLASS = "work-thread-link inline-flex h-6 min-w-0 items-center gap-1 rounded-md bg-state-hover px-1.5 text-[11px] text-foreground hover:bg-state-active pointer-coarse:h-9 pointer-coarse:px-2.5";
const LINK_KIND_NAME: Record<TaskLinkKind, string> = { pr: "Pull request", issue: "Issue", link: "Link" };

function ExternalLinks({ links }: { links: string[] }) {
  const labels = links.map((link) => ({ link, ...taskLinkLabel(link) }));
  // Name the repository only when the card's PRs span several repositories.
  const repos = new Set(labels.filter((entry) => entry.kind === "pr").map((entry) => entry.label.split("#")[0]));
  return <>{labels.map(({ link, kind, label }) => {
    const shown = kind === "pr" ? `PR ${repos.size > 1 ? label : `#${label.split("#")[1]}`}` : label;
    return <UrlLink key={link} href={link} draggable={false} className={EXTERNAL_CHIP_CLASS} title={link} aria-label={`${LINK_KIND_NAME[kind]} ${label}, opens outside BB`} data-link-kind={kind}>
      <LinkIcon kind={kind} /><span className="max-w-[10rem] truncate">{shown}</span><ExternalIcon />
    </UrlLink>;
  })}</>;
}

function ThreadLink({ role, threadId, thread, archived, botName }: { role: "worker" | "owner"; threadId: string; thread: PluginSidebarThread | undefined; archived: boolean; botName: string }) {
  const navigate = useBbNavigate();
  const label = role === "worker" ? "Worker thread" : "Owner thread";
  // A conversation outside the sidebar list has no title here; name only what is known.
  const name = `${role === "owner" ? `${botName}'s owner thread` : "worker thread"}${archived ? " (archived)" : ""}${thread ? `: ${threadTitle(thread)}` : ""}`;
  return <button type="button" className={THREAD_CHIP_CLASS} data-thread-role={role} data-archived={archived} title={name[0]!.toUpperCase() + name.slice(1)} aria-label={`Open ${name}`} onClick={() => navigate.toThread(threadId)}>
    {thread && !archived ? <ConversationStatusIcon thread={thread} /> : <ThreadIcon />}<span className="truncate">{label}</span>{archived ? <span className="text-muted-foreground">(archived)</span> : null}
  </button>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-0.5">
    <h4 className="text-[11px] font-medium text-muted-foreground">{label}</h4>
    <div className="text-xs leading-5 text-foreground">{children}</div>
  </div>;
}

// A quiet alternative to dragging for touch and keyboard users.
function CardMenu({ task, column, onMove, onEditNotes }: { task: BotTask; column: ColumnId; onMove: (column: ColumnId) => void; onEditNotes: () => void }) {
  const portalScope = usePortalScopeProps();
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><Button type="button" variant="ghost" size="sm" className="work-card-menu h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground pointer-coarse:h-9 pointer-coarse:w-9" aria-label={`Actions for ${task.title}. Now in ${columnTitle(column)}`}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
    </Button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content {...portalScope} align="end" sideOffset={4} className="z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
      <DropdownMenu.Label className="px-2 py-1 text-[11px] text-muted-foreground">Move to</DropdownMenu.Label>
      {COLUMNS.map((entry) => <DropdownMenu.Item key={entry.id} disabled={entry.id === column} className={MENU_ITEM_CLASS} onSelect={() => onMove(entry.id)}>{entry.title}</DropdownMenu.Item>)}
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={onEditNotes}>Edit notes</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

// Optional notes, editable after a move. Save is explicit; Enter in a field never submits.
function NotesEditor({ task, column, onSave, onClose }: { task: BotTask; column: ColumnId; onSave: (change: Change) => Promise<void>; onClose: () => void }) {
  const id = useId();
  const [nextStep, setNextStep] = useState(task.nextStep);
  const [outcome, setOutcome] = useState(task.outcome);
  const [waitingOn, setWaitingOn] = useState<WaitingOn>(task.waitingOn && task.waitingOn !== "michael" ? task.waitingOn : "other");
  const [waitingFor, setWaitingFor] = useState(task.waitingFor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  async function save() {
    setPending(true); setError(null);
    try {
      await onSave(column === "done" ? { status: "done", outcome: outcome.trim() }
        : { status: task.status, nextStep: nextStep.trim(), ...(column === "others" ? { waitingOn, waitingFor: waitingFor.trim() } : {}) });
      onClose();
    } catch (cause) { setError(errorText(cause)); } finally { setPending(false); }
  }
  return <form className="work-notes space-y-2 rounded-md border border-border p-2" aria-label={`Notes for ${task.title}`} onSubmit={(event) => event.preventDefault()} onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    {column === "done"
      ? <label className="block space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-outcome`}>Outcome (optional)
          <textarea ref={first} id={`${id}-outcome`} className={`${FIELD_CLASS} min-h-14 py-1`} maxLength={1000} value={outcome} disabled={pending} onChange={(event) => setOutcome(event.target.value)} />
        </label>
      : <label className="block space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-next`}>Next step (optional)
          <textarea ref={first} id={`${id}-next`} className={`${FIELD_CLASS} min-h-14 py-1`} maxLength={500} value={nextStep} disabled={pending} onChange={(event) => setNextStep(event.target.value)} />
        </label>}
    {column === "others" ? <div className="grid grid-cols-2 gap-2">
      <label className="space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-on`}>Waiting on
        <select id={`${id}-on`} className={`${FIELD_CLASS} h-7`} value={waitingOn} disabled={pending} onChange={(event) => setWaitingOn(event.target.value as WaitingOn)}>
          <option value="other">Someone else</option><option value="agent">An agent</option>
        </select>
      </label>
      <label className="space-y-1 text-[11px] text-muted-foreground" htmlFor={`${id}-who`}>Who (optional)
        <input id={`${id}-who`} className={`${FIELD_CLASS} h-7`} maxLength={120} value={waitingFor} disabled={pending} placeholder="e.g. Mosyle administrator" onChange={(event) => setWaitingFor(event.target.value)} />
      </label>
    </div> : null}
    {error ? <p role="alert" className="text-[11px] text-destructive">{error}</p> : null}
    <div className="flex items-center gap-2">
      <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={pending} onClick={() => void save()}>{pending ? "Saving…" : "Save notes"}</Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={pending} onClick={onClose}>Cancel</Button>
    </div>
  </form>;
}

type CardProps = {
  task: BotTask; column: ColumnId; bots: Map<string, TaskBot>; threadBots: Record<string, string>; archivedThreads: Set<string>; threads: Map<string, PluginSidebarThread>; now: number;
  saving: boolean; expanded: boolean; onToggle: () => void; onMove: (column: ColumnId) => void; onSaveNotes: (change: Change) => Promise<void>;
  onAcknowledge: (acknowledged: boolean) => void; onDragStart: (event: DragEvent) => void; onDragEnd: () => void; dragging: boolean;
};
function TaskCard({ task, column, bots, threadBots, archivedThreads, threads, now, saving, expanded, onToggle, onMove, onSaveNotes, onAcknowledge, onDragStart, onDragEnd, dragging }: CardProps) {
  const navigate = useBbNavigate();
  const detailId = useId();
  const [editing, setEditing] = useState(false);
  // Links and buttons on the card are click targets, never drag handles.
  const dragAllowed = useRef(true);
  const bot = bots.get(task.botId);
  const botName = bot?.name ?? "Unknown bot";
  // The owner thread is the bot's selected main, linked only while it still belongs to that bot.
  const ownerThreadId = bot?.mainThreadId && threadBots[bot.mainThreadId] === bot.id ? bot.mainThreadId : null;
  const workerThreadId = task.threadId && task.threadId !== ownerThreadId ? task.threadId : null;
  // Existing records may predate askThreadId; the latest writer can explain them.
  const askThreadId = task.askThreadId ?? task.updatedByThreadId ?? task.threadId;
  const askName = (askThreadId ? bots.get(threadBots[askThreadId] ?? "")?.name : undefined) ?? threadTitle(askThreadId ? threads.get(askThreadId) : undefined);
  const unread = task.status === "done" && task.needsAcknowledgement;
  const status = cardStatus(task, column);
  const index = COLUMNS.findIndex((entry) => entry.id === column);
  const onKeyDown = (event: KeyboardEvent) => {
    // Alt+Arrow moves the card to the previous or next column.
    if (!event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const target = COLUMNS[index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1)];
    event.preventDefault();
    if (target) onMove(target.id);
  };
  // Raw conversation IDs in the text read as their role on this card.
  const labels: Record<string, string> = { ...(workerThreadId ? { [workerThreadId]: "worker thread" } : {}), ...(ownerThreadId ? { [ownerThreadId]: "owner thread" } : {}) };
  const readable = (text: string) => withThreadLabels(text, labels).trim();
  const summary = readable(primaryText(task));
  const extended = Boolean(task.recommendation || task.options.length || task.context || (task.status !== "done" && task.outcome));
  return <li className="work-card rounded-lg border border-border bg-background data-[dragging=true]:opacity-40 data-[saving=true]:opacity-70" data-task-id={task.id} data-dragging={dragging} data-saving={saving} draggable={!editing && !expanded}
    onPointerDownCapture={(event) => { dragAllowed.current = !(event.target as Element).closest("a, button:not(.work-card-toggle), input, textarea, select"); }}
    onDragStart={(event) => { if (!dragAllowed.current) { event.preventDefault(); return; } onDragStart(event); }} onDragEnd={onDragEnd}>
    {/* An expanded card drags by its header only, so its full text stays selectable. */}
    <div className="work-card-header flex items-start gap-1 p-2 pb-1" draggable={expanded && !editing}>
      <button type="button" className="work-card-toggle flex min-w-0 flex-1 cursor-grab select-none items-start gap-1 rounded-sm text-left active:cursor-grabbing" data-focus-key={task.id} aria-expanded={expanded} aria-controls={detailId}
        aria-label={`${task.title}. ${columnTitle(column)}${unread ? ", new result" : ""}. ${expanded ? "Collapse" : "Expand"}. Alt+Arrow keys move it.`} onClick={onToggle} onKeyDown={onKeyDown}>
        <span className="mt-0.5 text-muted-foreground"><Chevron direction={expanded ? "down" : "right"} /></span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block break-words text-[13px] font-medium leading-5 text-foreground">{task.title}</span>
          <span className="work-status-line flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            {/* Only a long waiting owner may truncate; short states always read in full. */}
            <span className={`work-status flex items-center gap-1.5 font-medium text-foreground ${status.tone === "waiting" ? "min-w-[3rem]" : "shrink-0"}`} data-tone={status.tone} title={status.text}>
              <span aria-hidden="true" className="work-status-dot size-1.5 shrink-0 rounded-full" /><span className={expanded ? "" : "truncate"}>{status.text}</span>
            </span>
            <span aria-hidden="true">·</span>
            {/* A long waiting owner truncates, never the bot name; otherwise the bot name may. */}
            <span className={`flex items-center gap-1 ${status.tone === "waiting" ? "max-w-[6rem] shrink-0" : "min-w-0"}`}>{bot ? <BotIcon avatar={bot.avatar} size={14} /> : null}<span className="truncate" title={botName}>{botName}</span></span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0"><Age at={task.updatedAt} now={now} /></span>
          </span>
        </span>
      </button>
      <CardMenu task={task} column={column} onMove={onMove} onEditNotes={() => { if (!expanded) onToggle(); setEditing(true); }} />
    </div>
    {/* Outside the toggle: selectable text, never part of the button's name. A click on the
        clamped text expands the card; keyboard users have the toggle. */}
    <p className={`work-summary mb-1.5 ml-[22px] mr-2 break-words text-xs leading-[18px] ${expanded ? "select-text whitespace-pre-wrap" : "line-clamp-2 cursor-pointer"} ${summary ? "text-foreground/85" : "italic text-muted-foreground"}`}
      onClick={expanded ? undefined : onToggle}>
      {summary ? <><span className="text-muted-foreground">{task.status === "done" ? "Result: " : "Next: "}</span>{summary}</> : task.status === "done" ? "No outcome recorded." : "No next step recorded."}
    </p>
    <div className="work-links flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2 pl-[22px]">
      <ExternalLinks links={task.links} />
      {workerThreadId ? <ThreadLink role="worker" threadId={workerThreadId} thread={threads.get(workerThreadId)} archived={archivedThreads.has(workerThreadId)} botName={botName} /> : null}
      {ownerThreadId ? <ThreadLink role="owner" threadId={ownerThreadId} thread={threads.get(ownerThreadId)} archived={archivedThreads.has(ownerThreadId)} botName={botName} /> : null}
      {!task.links.length ? <span className="work-no-links px-0.5 text-[11px] italic text-muted-foreground">{workerThreadId || ownerThreadId ? "No PR or proof link" : "No links recorded"}</span> : null}
      {saving ? <span role="status" className="text-[11px] text-muted-foreground">Saving…</span> : null}
      {unread ? <Button type="button" variant="outline" size="sm" className="work-acknowledge ml-auto h-6 px-2 text-[11px] pointer-coarse:h-9 pointer-coarse:px-3" onClick={() => onAcknowledge(true)}>Acknowledge</Button> : null}
    </div>
    <div id={detailId} hidden={!expanded} className="work-card-detail space-y-3 border-t border-border px-2 py-2">
      {expanded ? <>
        {editing ? <NotesEditor task={task} column={column} onSave={onSaveNotes} onClose={() => setEditing(false)} /> : <>
          {task.recommendation ? <Field label="Recommendation"><p className="whitespace-pre-wrap">{readable(task.recommendation)}</p></Field> : null}
          {task.options.length ? <Field label="Options"><ol className="list-decimal space-y-0.5 pl-4">{task.options.map((option) => <li key={option}>{readable(option)}</li>)}</ol></Field> : null}
          {task.context ? <Field label="Context"><p className="whitespace-pre-wrap">{readable(task.context)}</p></Field> : null}
          {task.status !== "done" && task.outcome ? <Field label="Last result"><p className="whitespace-pre-wrap">{readable(task.outcome)}</p></Field> : null}
          {!extended ? <p className="text-xs text-muted-foreground">No further context recorded.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}>Edit notes</Button>
            {askThreadId ? <Button type="button" variant="outline" size="sm" className="work-ask h-7 text-xs" onClick={() => { queueAskPrefill(askThreadId, askQuestion(task)); navigate.toThread(askThreadId); }}>Ask {askName} to explain</Button> : null}
            {task.status === "done" && !unread ? <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAcknowledge(!task.acknowledgedAt)}>{task.acknowledgedAt ? "Mark unread" : "Acknowledge"}</Button> : null}
          </div>
          {askThreadId ? <p className="text-[11px] text-muted-foreground">Ask opens {askName}'s conversation with an unsent question you can edit.</p> : null}
        </>}
      </> : null}
    </div>
  </li>;
}

export function WorkPanel() {
  const { data, error, rpc, refresh } = useTasks();
  const sidebar = experimental_useSidebarThreads();
  const now = useMinuteClock();
  const root = useRef<HTMLDivElement>(null);
  const width = usePanelWidth(root);
  const columnsLayout = width >= COLUMN_LAYOUT_MIN_WIDTH;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Optimistic placement while a move saves; cleared on success or rolled back on failure.
  const [pendingMoves, setPendingMoves] = useState<Map<string, ColumnId>>(() => new Map());
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<ColumnId | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<{ text: string; error: boolean } | null>(null);
  const restoreFocus = useRef<string | null>(null);
  const threads = useMemo(() => new Map(sidebar.threads.map((thread) => [thread.id, thread])), [sidebar.threads]);
  const bots = useMemo(() => new Map((data?.bots ?? []).map((bot) => [bot.id, bot])), [data]);
  const archivedThreads = useMemo(() => new Set(data?.archivedThreadIds ?? []), [data]);
  useEffect(() => {
    const key = restoreFocus.current;
    if (!key) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
    if (!target) return; // A moved card may render after the refresh.
    restoreFocus.current = null;
    target.focus();
  });

  async function move(task: BotTask, column: ColumnId) {
    const from = pendingMoves.get(task.id) ?? columnOf(task);
    if (column === from) return;
    setAnnouncement(null);
    setPendingMoves((current) => new Map(current).set(task.id, column));
    if (column === "done") setHistoryOpen(true);
    restoreFocus.current = task.id;
    try {
      await rpc.call("task_set_status", { taskId: task.id, ...moveChange(task, column) });
      await refresh();
      setAnnouncement({ text: `Moved “${task.title}” to ${columnTitle(column)}.`, error: false });
    } catch (cause) {
      setAnnouncement({ text: `Could not move “${task.title}”: ${errorText(cause)} It stayed in ${columnTitle(from)}.`, error: true });
    } finally {
      setPendingMoves((current) => { const next = new Map(current); next.delete(task.id); return next; });
      restoreFocus.current = task.id;
    }
  }
  const saveNotes = async (task: BotTask, change: Change) => {
    await rpc.call("task_set_status", { taskId: task.id, ...change });
    await refresh();
    setAnnouncement({ text: `Saved notes for “${task.title}”.`, error: false });
  };
  // Acknowledging keeps the keyboard in place: focus the next new result, else history.
  const acknowledge = (task: BotTask, acknowledged: boolean) => {
    setAnnouncement(null);
    const unread = (data?.tasks ?? []).filter((entry) => entry.status === "done" && entry.needsAcknowledgement);
    const next = unread[unread.findIndex((entry) => entry.id === task.id) + 1] ?? unread.find((entry) => entry.id !== task.id);
    rpc.call("task_acknowledge", { taskId: task.id, acknowledged }).then(async () => {
      await refresh();
      restoreFocus.current = acknowledged ? next?.id ?? "done-history" : task.id;
      setAnnouncement({ text: acknowledged ? `Acknowledged “${task.title}”.` : `Marked “${task.title}” unread.`, error: false });
    }, (cause) => setAnnouncement({ text: `Could not update “${task.title}”: ${errorText(cause)}`, error: true }));
  };
  const onDrop = (event: DragEvent, column: ColumnId) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData(DRAG_TYPE) || dragTaskId;
    setDropColumn(null); setDragTaskId(null);
    const task = data?.tasks.find((entry) => entry.id === taskId);
    if (task) void move(task, column);
  };

  let body: ReactNode = null;
  if (data) {
    const placed = (task: BotTask) => pendingMoves.get(task.id) ?? columnOf(task);
    // Needs acknowledgement stays visible; Michael's own and older results form history.
    const history = (task: BotTask) => task.status === "done" && !task.needsAcknowledgement && !pendingMoves.has(task.id);
    const card = (task: BotTask, column: ColumnId) => <TaskCard key={task.id} task={task} column={column} bots={bots} threadBots={data.threadBots} archivedThreads={archivedThreads} threads={threads} now={now}
      saving={pendingMoves.has(task.id)} expanded={expanded.has(task.id)} dragging={dragTaskId === task.id}
      onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; })}
      onMove={(target) => void move(task, target)} onSaveNotes={(change) => saveNotes(task, change)} onAcknowledge={(value) => acknowledge(task, value)}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(DRAG_TYPE, task.id); setDragTaskId(task.id); }}
      onDragEnd={() => { setDragTaskId(null); setDropColumn(null); }} />;
    body = <div className={columnsLayout ? "work-board grid min-h-0 flex-1 grid-cols-4 gap-2" : "work-board flex flex-col gap-3"} data-layout={columnsLayout ? "columns" : "lanes"} data-dragging={Boolean(dragTaskId)}>
      {COLUMNS.map((column) => {
        const cards = data.tasks.filter((task) => placed(task) === column.id && !history(task));
        const old = column.id === "done" ? data.tasks.filter(history) : [];
        const dragged = dragTaskId ? data.tasks.find((task) => task.id === dragTaskId) : undefined;
        // The dragged card's own column is not a target; dropping there changes nothing.
        const source = dragged ? placed(dragged) === column.id : false;
        const target = dropColumn === column.id && !source;
        return <section key={column.id} aria-labelledby={`work-${column.id}`} data-work-column={column.id} data-drop-target={target}
          className={`work-column relative flex min-h-0 flex-col rounded-lg border p-1.5 transition-colors duration-150 ${target ? "border-foreground/60 bg-state-active ring-1 ring-foreground/30" : dragTaskId && !source ? "border-dashed border-border bg-state-hover/40" : "border-transparent"}`}
          onDragOver={(event) => { if (!event.dataTransfer.types.includes(DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropColumn(column.id); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropColumn((current) => current === column.id ? null : current); }}
          onDrop={(event) => onDrop(event, column.id)}>
          <h2 id={`work-${column.id}`} className="mb-1.5 flex select-none items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {column.title}
            <span className={`work-count tabular-nums ${column.id === "michael" && cards.length ? "rounded-full bg-state-active px-1.5 font-semibold text-foreground" : "font-normal"}`}>{cards.length}</span>
            {column.id === "done" && cards.length ? <span className="sr-only">new results need acknowledgement</span> : null}
          </h2>
          {/* An overlay, not an inserted row: the layout must not shift under the pointer. */}
          {target && cards.length ? <p className="work-drop-hint pointer-events-none absolute inset-x-1.5 top-8 z-10 rounded-md border border-dashed border-foreground/50 bg-popover/95 px-2 py-1.5 text-center text-xs font-medium text-foreground shadow-sm">Drop to move to {column.title}</p> : null}
          <ul className={`space-y-1.5 ${columnsLayout ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>{cards.map((task) => card(task, column.id))}</ul>
          {!cards.length ? <p className="px-1 py-2 text-xs text-muted-foreground">{target ? `Drop to move to ${column.title}` : column.empty}</p> : null}
          {old.length ? <div className="mt-1.5">
            <button type="button" data-focus-key="done-history" aria-expanded={historyOpen} aria-controls="work-done-history" className="flex w-full items-center gap-1 rounded-sm px-1 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setHistoryOpen((value) => !value)}>
              <Chevron direction={historyOpen ? "down" : "right"} />History <span className="tabular-nums">{old.length}</span>
            </button>
            <ul id="work-done-history" hidden={!historyOpen} className="mt-1 space-y-1.5">{historyOpen ? old.slice(0, HISTORY_SHOWN).map((task) => card(task, "done")) : null}</ul>
            {historyOpen && old.length > HISTORY_SHOWN ? <p className="px-1 text-[11px] text-muted-foreground">{old.length - HISTORY_SHOWN} older results hidden. See bb bots task list --status done.</p> : null}
          </div> : null}
        </section>;
      })}
    </div>;
  }
  // Right-panel tab (flush layout): the panel owns its padding and scrolling.
  return <div ref={root} className="work-panel flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <p role={announcement?.error ? "alert" : "status"} className={`min-h-4 px-1 text-[11px] ${announcement?.error ? "text-destructive" : "text-muted-foreground"}`}>{announcement?.text ?? (data ? "Move a card by dragging it, with Alt+Arrow, or from its ⋯ menu." : "")}</p>
    {!data && !error ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : null}
    {body}
  </div>;
}
