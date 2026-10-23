"use client";
import { Check } from "lucide-react";
import type { AgentJobStep } from "@/lib/ai/agent/jobState";
import { chatExperienceCopy, progressLines, type ChatLocale } from "./chatExperience";

/** The instant "Got it" line plus one short line per finished step. */
export default function ChatJobProgress({ locale, acknowledged, steps, note }: {
  locale: ChatLocale; acknowledged: boolean; steps: AgentJobStep[]; note?: string | null;
}) {
  const copy = chatExperienceCopy(locale);
  const lines = progressLines(steps, copy);
  if (!acknowledged && lines.length === 0 && !note) return null;
  return <div className="w-full space-y-1 ps-1 text-[15px] text-ink-muted" role="status" aria-live="polite"
    dir={locale === "ar" ? "rtl" : "ltr"}>
    {acknowledged && <p className="font-semibold text-ink">{copy.ack}</p>}
    {lines.map((line, i) => <p key={i + line} className="flex items-center gap-2">
      <Check size={16} aria-hidden="true" className="shrink-0 text-good" />{line}
    </p>)}
    {note && <p>{note}</p>}
  </div>;
}
