import { useEffect, useState } from "react";
import { useComposer, useComposerView } from "@get-bb/plugin-sdk/app";
import { subscribeAskPrefill, takeAskPrefill } from "../lib/ask-prefill";

// Invisible composer banner: fills this thread's draft with a queued Work
// question. It appends to an existing draft and never submits.
export function AskPrefillBridge() {
  const composer = useComposer();
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [signal, setSignal] = useState(0);
  useEffect(() => subscribeAskPrefill(() => setSignal((value) => value + 1)), []);
  useEffect(() => {
    if (!threadId) return;
    const text = takeAskPrefill(threadId);
    if (text) composer.updateText((current) => current.trim() ? `${current.trimEnd()}\n\n${text}` : text);
  }, [threadId, signal, composer]);
  return null;
}
