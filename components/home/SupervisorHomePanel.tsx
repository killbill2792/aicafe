"use client";

import { Sparkles, UsersRound } from "lucide-react";
import SupervisorChatComposer, { type SupervisorChatCopy, type SupervisorHomeSnapshot } from "./SupervisorChatComposer";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import { Link } from "@/i18n/navigation";

type SupervisorCopy = {
  eyebrow: string; heading: string; intro: string; teamButton: string;
  askAnything: string; composerLabel: string; addAttachment: string;
  voiceInput: string; sendMessage: string; comingSoon: string; suggestions: string[];
};

export default function SupervisorHomePanel({
  copy, chatCopy, chatEnabled, chatUnavailableReason, locale, snapshot,
}: {
  copy: SupervisorCopy;
  chatCopy: Omit<SupervisorChatCopy, keyof SupervisorCopy>;
  snapshot: SupervisorHomeSnapshot;
  chatEnabled: boolean;
  chatUnavailableReason: SupervisorChatUnavailableReason | null;
  locale: "en" | "es" | "ar";
}) {
  return (
    <section className="rounded-[28px] border border-[#D8C8B5] bg-[#F0E5D8] p-3 shadow-[0_18px_48px_rgba(42,29,20,0.08)] md:p-4">
      <div className="flex items-center justify-between gap-3 px-2 py-1">
        <span className="flex items-center gap-2 text-sm font-extrabold text-ink">
          <Sparkles aria-hidden="true" size={19} /> {copy.eyebrow}
        </span>
        <Link href="/operations"
          className="flex min-h-11 items-center gap-2 rounded-full bg-ink px-4 text-[15px] font-bold text-paper no-underline hover:bg-[#483126] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
          <UsersRound aria-hidden="true" size={19} />{copy.teamButton}
        </Link>
      </div>
      <SupervisorChatComposer
        enabled={chatEnabled} unavailableReason={chatUnavailableReason}
        snapshot={snapshot} locale={locale} copy={{ ...copy, ...chatCopy }}
      />
    </section>
  );
}
