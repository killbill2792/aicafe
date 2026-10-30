"use client";

import { use } from "react";
import ChatStart, { type ChatStartCopy, type ChatStartData, type ChatStartProps } from "./ChatStart";

export type HomeStartPayload = {
  data: ChatStartData;
  copy: Omit<ChatStartCopy, "suggestions">;
};

/** Only the board suspends. The chat composer remains mounted and interactive. */
export default function DeferredChatStart({
  promise, suggestions, failureText, ...props
}: Omit<ChatStartProps, "data" | "copy"> & {
  promise: Promise<HomeStartPayload | null>;
  suggestions: string[];
  failureText: string;
}) {
  const result = use(promise);
  if (!result) {
    return <p role="status" className="rounded-xl border border-line bg-surface2 p-3 text-[17px] text-ink-muted">
      {failureText}
    </p>;
  }
  return <ChatStart {...props} data={result.data} copy={{ ...result.copy, suggestions }} />;
}
