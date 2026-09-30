// Task links are user-visible references (PRs, issues), so accept only plain
// https URLs without embedded credentials. Labels are derived, never stored.
export const TASK_LINK_MAX_CHARS = 500;

export function isSafeTaskLink(value: string): boolean {
  if (value.length > TASK_LINK_MAX_CHARS || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export type TaskLinkKind = "pr" | "issue" | "link";
export function taskLinkLabel(value: string): { kind: TaskLinkKind; label: string } {
  const url = new URL(value);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com" && parts.length >= 4 && /^\d+$/.test(parts[3]!)) {
    if (parts[2] === "pull") return { kind: "pr", label: `${parts[1]}#${parts[3]}` };
    if (parts[2] === "issues") return { kind: "issue", label: `${parts[1]}#${parts[3]}` };
  }
  if (url.hostname === "github.com" && parts[2] === "commit" && parts[3]) return { kind: "link", label: `${parts[1]}@${parts[3].slice(0, 7)}` };
  if (url.hostname === "github.com" && parts[2] === "actions" && parts[3] === "runs" && parts[4]) return { kind: "link", label: `${parts[1]} CI run` };
  if (url.hostname === "linear.app" && parts[1] === "issue" && parts[2]) return { kind: "issue", label: parts[2].toUpperCase() };
  if (url.hostname.endsWith(".atlassian.net") && parts[0] === "browse" && parts[1]) return { kind: "issue", label: parts[1].toUpperCase() };
  return { kind: "link", label: url.hostname };
}

// Card summaries read as prose; raw conversation IDs (thr_…) belong to the thread links.
export function withoutThreadIds(text: string): string {
  return text.replace(/\s*\((?:@thread:)?thr_[a-z0-9]{6,}\)|\s*(?:@thread:)?\bthr_[a-z0-9]{6,}\b/gi, "").replace(/^\s*[:,;-]\s*/, "").replace(/[ \t]{2,}/g, " ").trim();
}
