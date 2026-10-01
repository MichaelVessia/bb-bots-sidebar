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
