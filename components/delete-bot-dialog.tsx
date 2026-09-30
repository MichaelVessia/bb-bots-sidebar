import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function DeleteBotDialog({ name, conversationCount, ownedProjectNames, joinedProjectNames, onDelete, onClose }: {
  name: string;
  conversationCount: number;
  ownedProjectNames: string[];
  joinedProjectNames: string[];
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = useRef(false);
  const confirmed = typed === name;

  async function remove() {
    if (!confirmed || deleting.current) return;
    deleting.current = true;
    setPending(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      deleting.current = false;
      setPending(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !deleting.current) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete bot</DialogTitle>
        <DialogDescription>Delete {name} and its private state. You cannot undo this.</DialogDescription>
      </DialogHeader>
      <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        <li>Its SOUL.md, MEMORY.md, and settings are deleted.</li>
        <li>{conversationCount ? `Its ${plural(conversationCount, "conversation")} stay in BB and move to Chats.` : "It has no open conversations."} Archived conversations also stay.</li>
        {ownedProjectNames.length ? <li>It releases ownership of {ownedProjectNames.join(", ")}. New conversations there no longer go to this bot.</li> : null}
        {joinedProjectNames.length ? <li>It leaves {joinedProjectNames.join(", ")}.</li> : null}
        <li>Project files do not change.</li>
      </ul>
      <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
        Type <span className="font-semibold text-foreground">{name}</span> to confirm
        <Input autoFocus aria-label="Bot name to confirm deletion" value={typed} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }} />
      </label>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button type="button" variant="destructive" disabled={pending || !confirmed} onClick={() => void remove()}>{pending ? "Deleting…" : "Delete bot"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
