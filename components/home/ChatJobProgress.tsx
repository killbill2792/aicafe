"use client";
import type { AgentJobStep } from "@/lib/ai/agent/jobState";
import { chatExperienceCopy, progressLines, type ChatLocale } from "./chatExperience";

/** Decorative coffee steam accompanies a real pending state. The text beside it
 * remains the status authority; animation never claims completion or an effect. */
export function CafeActivity({ brewing = true }: { brewing?: boolean }) {
  return <svg data-cafe-motion={brewing ? "brewing" : "still"} aria-hidden="true" focusable="false"
    viewBox="0 0 32 32" className="h-8 w-8 shrink-0 text-accent-text" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 15h17v5a6 6 0 0 1-6 6h-5a6 6 0 0 1-6-6v-5M23 16h2a3.5 3.5 0 0 1 0 7h-3M4 29h23"/>
    <path className={brewing ? "supervisor-steam" : undefined} d="M11 12c-3-3 3-4 0-7"/>
    <path className={brewing ? "supervisor-steam supervisor-steam-second" : undefined} d="M17 12c-3-3 3-4 0-7"/>
  </svg>;
}

/** A tool-progress line records investigation, never verified side-effect completion. */
export default function ChatJobProgress({ locale, acknowledged, steps, note }: {
  locale: ChatLocale; acknowledged: boolean; steps: AgentJobStep[]; note?: string | null;
}) {
  const copy = chatExperienceCopy(locale);
  const line = note || progressLines(steps, copy).at(-1) || (acknowledged ? copy.ack : null);
  if (!line) return null;
  return <div className="flex w-full items-center gap-2 text-[15px] leading-snug text-ink-muted"
    role="status" aria-live="polite" aria-atomic="true" data-testid="supervisor-live-progress"
    dir={locale === "ar" ? "rtl" : "ltr"}>
    <CafeActivity/><span className="min-w-0">{line}</span>
  </div>;
}
