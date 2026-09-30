import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { TASK_LIMIT, TASK_STATUSES, WAITING_ON, taskSchema, type WaitingOn, type BotMetadata, type BotTask, type TaskStatus } from "../contract";
import type { BotStore } from "./bot-store";
import { nextTimestamp } from "./bot-store";

export const TASK_USAGE = `bb bots task list [--status now|waiting|done] [--bot <bot>] [--thread <conversation-id>] [--json]
bb bots task set [<task-id>] [--title <title>] [--status now|waiting|done] [--bot <bot>]
                 [--thread <conversation-id>|none] [--link <https-url>]... [--next <step>] [--outcome <text>]
                 [--context <text>] [--recommendation <text>] [--option <choice>]... [--ask-thread <conversation-id>|none]
                 [--waiting-on michael|other|agent] [--waiting-for <who>] [--json]
bb bots task remove <task-id> [--json]

Tasks feed the Work view: Now, Waiting on Michael, and Done. Records are explicit;
BB never infers a task's outcome from an idle conversation.
Without <task-id>, set creates a task and prints its ID; --title and --status are required.
The owner defaults to the invoking conversation's bot, and the linked thread to the
invoking conversation. Use --thread none for no thread. Repeated --link options replace
all links (max 5 https URLs, e.g. a PR or issue); --link none clears them.
Now/Waiting need --next; Done needs --outcome.
For decisions, --next states exactly what Michael must decide or do. --context (2000),
--recommendation (1000), and up to 5 single-line --option choices appear in the task
detail; repeated --option replaces the list and --option none clears it. The Ask action
drafts an unsent question in --ask-thread, which defaults to the creating conversation.
Creating or updating a Done task puts it in Needs acknowledgement until Michael reads it.
Waiting tasks name who holds the next action: --waiting-on michael, other (someone else:
a person, team, or external party), or agent, plus --waiting-for with a name (120), e.g.
"Mosyle administrator". The older value external is accepted and stored as other.
Without --waiting-on the Work view shows the owner as not recorded, never as Michael.
Leaving Waiting clears both fields.`;

type TaskFields = Partial<Pick<BotTask, "title" | "status" | "botId" | "threadId" | "links" | "nextStep" | "outcome" | "context" | "recommendation" | "options" | "askThreadId" | "waitingOn" | "waitingFor">>;

export function createTaskStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const decode = (data: string) => taskSchema.parse(JSON.parse(data));
  const get = (id: string): BotTask | null => {
    const row = db.prepare("SELECT data FROM bot_tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? decode(row.data) : null;
  };
  return {
    get,
    list(): BotTask[] { return (db.prepare("SELECT data FROM bot_tasks ORDER BY updated_at DESC, id").all() as { data: string }[]).map((row) => decode(row.data)); },
    // Validate the merged record inside one transaction so partial updates
    // never persist an incomplete task.
    // byMichael marks his own panel edits: he wrote that result, so it needs no acknowledgement.
    set(taskId: string | null, fields: TaskFields, updatedByThreadId: string | null, byMichael = false): BotTask {
      return db.transaction(() => {
        const current = taskId ? get(taskId) : null;
        if (taskId && !current) throw new Error(`Task not found: ${taskId}. Use bb bots task list for IDs.`);
        if (!current && (db.prepare("SELECT COUNT(*) AS count FROM bot_tasks").get() as { count: number }).count >= TASK_LIMIT) throw new Error(`The Work view holds at most ${TASK_LIMIT} tasks. Remove old Done tasks with bb bots task remove.`);
        const now = Date.now();
        const next = {
          id: current?.id ?? `task_${randomUUID().replaceAll("-", "")}`, threadId: null, links: [], nextStep: "", outcome: "",
          ...current, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
          createdAt: current?.createdAt ?? now, updatedAt: current ? nextTimestamp(current.updatedAt) : now, updatedByThreadId,
          acknowledgedAt: null,
        };
        next.needsAcknowledgement = next.status === "done" && !byMichael;
        // A waiting owner describes Waiting only; never carry a stale one forward.
        if (next.status !== "waiting") Object.assign(next, { waitingOn: null, waitingFor: "" });
        else if (next.waitingOn === "michael") next.waitingFor = "";
        const merged = taskSchema.safeParse(next);
        if (!merged.success) throw new Error(merged.error.issues.map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`).join("; "));
        const task = merged.data;
        db.prepare("INSERT INTO bot_tasks(id,data,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").run(task.id, JSON.stringify(task), task.updatedAt);
        return task;
      }).immediate();
    },
    // Acknowledgement is Michael's read state, not task progress: keep updatedAt.
    acknowledge(id: string, acknowledged: boolean): BotTask {
      return db.transaction(() => {
        const current = get(id);
        if (!current) throw new Error("This task no longer exists.");
        if (acknowledged && current.status !== "done") throw new Error("Only Done tasks can be acknowledged.");
        // Marking unread returns a Done result to Needs acknowledgement.
        const task = taskSchema.parse({ ...current, acknowledgedAt: acknowledged ? Date.now() : null, needsAcknowledgement: !acknowledged && current.status === "done" });
        db.prepare("UPDATE bot_tasks SET data = ? WHERE id = ?").run(JSON.stringify(task), id);
        return task;
      }).immediate();
    },
    remove(id: string): boolean { return db.prepare("DELETE FROM bot_tasks WHERE id = ?").run(id).changes > 0; },
  };
}
export type TaskStore = ReturnType<typeof createTaskStore>;

type TaskOptions = { command: "list" | "set" | "remove"; json: boolean; taskId?: string; status?: TaskStatus; waitingOn?: WaitingOn; waitingFor?: string; title?: string; bot?: string; thread?: string; links: string[]; options: string[]; next?: string; outcome?: string; context?: string; recommendation?: string; askThread?: string };
const TEXT_OPTIONS = { "--title": "title", "--bot": "bot", "--thread": "thread", "--next": "next", "--outcome": "outcome", "--context": "context", "--recommendation": "recommendation", "--ask-thread": "askThread", "--waiting-for": "waitingFor" } as const;
const REPEATED = ["--link", "--option"];
function parseTask(argv: string[]): TaskOptions | null {
  const command = argv[0];
  if (!command || command === "--help" || command === "help") return null;
  if (command !== "list" && command !== "set" && command !== "remove") throw new Error(`Unknown task command: ${command}\n${TASK_USAGE}`);
  const options: TaskOptions = { command, json: false, links: [], options: [] };
  const positional: string[] = [];
  const seen = new Set<string>();
  const allowed = command === "list" ? ["--status", "--bot", "--thread"] : command === "set" ? [...Object.keys(TEXT_OPTIONS), "--status", "--waiting-on", ...REPEATED] : [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help") return null;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (!allowed.includes(arg)) throw new Error(`Unknown option: ${arg}`);
    if (!REPEATED.includes(arg) && seen.has(arg)) throw new Error(`Repeated option: ${arg}`);
    seen.add(arg);
    const value = argv[++i];
    // Text values may legitimately be empty (to clear a field) but never a flag.
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--link") options.links.push(value);
    else if (arg === "--option") options.options.push(value);
    else if (arg === "--waiting-on") {
      const waitingOn = value === "external" ? "other" : value;
      if (!(WAITING_ON as readonly string[]).includes(waitingOn)) throw new Error("--waiting-on must be michael, other, or agent");
      options.waitingOn = waitingOn as WaitingOn;
    } else if (arg === "--status") {
      if (!(TASK_STATUSES as readonly string[]).includes(value)) throw new Error("--status must be now, waiting, or done");
      options.status = value as TaskStatus;
    } else options[TEXT_OPTIONS[arg as keyof typeof TEXT_OPTIONS]] = value;
  }
  if (command === "list" && positional.length) throw new Error(`Unexpected list arguments\n${TASK_USAGE}`);
  if (command === "set" && positional.length > 1) throw new Error(`Supply at most one task ID; quote values containing spaces\n${TASK_USAGE}`);
  if (command === "remove" && positional.length !== 1) throw new Error(`Supply one task ID\n${TASK_USAGE}`);
  options.taskId = positional[0];
  return options;
}

const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export function taskSummary(task: BotTask, bots: BotMetadata[]) {
  const owner = bots.find((bot) => bot.id === task.botId)?.name ?? task.botId;
  return [task.id, task.status, printable(owner), printable(task.title), task.threadId ?? "—", printable(task.status === "done" ? task.outcome : task.nextStep) || "—"].join("\t");
}

export async function runTaskCommand(deps: {
  bb: BbPluginApi; store: BotStore; tasks: TaskStore; publish: () => void;
  resolveOwner: (threadId: string, persist?: boolean) => Promise<string | null>;
  findBot: (bots: BotMetadata[], selector: string) => BotMetadata;
}, argv: string[], ctx: PluginCliContext) {
  const { bb, store, tasks, publish, resolveOwner, findBot } = deps;
  const options = parseTask(argv);
  if (!options) return { exitCode: 0, stdout: TASK_USAGE };
  const bots = store.list();
  if (options.command === "list") {
    const botId = options.bot ? findBot(bots, options.bot).id : undefined;
    const rows = tasks.list().filter((task) => (!options.status || task.status === options.status) && (!botId || task.botId === botId) && (!options.thread || task.threadId === options.thread));
    return { exitCode: 0, stdout: options.json ? JSON.stringify({ tasks: rows }) : [
      "TASK ID\tSTATUS\tOWNER\tTITLE\tTHREAD\tNEXT STEP / OUTCOME",
      ...rows.map((task) => taskSummary(task, bots)),
      `${rows.length} task${rows.length === 1 ? "" : "s"}.`,
    ].join("\n") };
  }
  if (options.command === "remove") {
    if (!tasks.remove(options.taskId!)) throw new Error(`Task not found: ${options.taskId}`);
    publish();
    return { exitCode: 0, stdout: options.json ? JSON.stringify({ removed: options.taskId }) : `Removed ${options.taskId}.` };
  }
  for (const [flag, values] of [["--link", options.links], ["--option", options.options]] as const) {
    if (values.includes("none") && values.length > 1) throw new Error(`${flag} none cannot be combined with other values`);
  }
  const creating = !options.taskId;
  if (creating && (!options.title || !options.status)) throw new Error(`A new task needs --title and --status\n${TASK_USAGE}`);
  // The caller's conversation must exist; its bot is the default owner.
  if (ctx.threadId) await bb.sdk.threads.get({ threadId: ctx.threadId });
  let botId = options.bot ? findBot(bots, options.bot).id : undefined;
  if (creating && !botId) {
    botId = ctx.threadId ? await resolveOwner(ctx.threadId, false) ?? undefined : undefined;
    if (!botId) throw new Error("This conversation belongs to no bot. Choose the owner with --bot <bot-id>.");
  }
  const conversation = async (value: string | undefined) => {
    const threadId = value === "none" ? null : value ?? (creating ? ctx.threadId ?? null : undefined);
    if (!threadId) return threadId;
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (!thread || thread.deletedAt) throw new Error(`Conversation not found: ${threadId}`);
    return thread.id;
  };
  const threadId = await conversation(options.thread);
  const askThreadId = await conversation(options.askThread);
  ctx.signal?.throwIfAborted();
  const task = tasks.set(options.taskId ?? null, {
    title: options.title, status: options.status, botId, threadId,
    links: options.links.length ? options.links.filter((link) => link !== "none") : undefined, nextStep: options.next, outcome: options.outcome,
    context: options.context, recommendation: options.recommendation, askThreadId,
    waitingOn: options.waitingOn, waitingFor: options.waitingFor,
    options: options.options.length ? options.options.filter((option) => option !== "none") : undefined,
  }, ctx.threadId ?? null);
  publish();
  return { exitCode: 0, stdout: options.json ? JSON.stringify({ task }) : `${creating ? "Created" : "Updated"} ${task.id} (${task.status}). Update it with: bb bots task set ${task.id} --status <now|waiting|done> ...` };
}
