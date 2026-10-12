"use client";

import SupervisorChatComposer, { type SupervisorChatCopy, type SupervisorHomeSnapshot } from "./SupervisorChatComposer";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";

type SupervisorCopy = {
  eyebrow: string; heading: string; intro: string; teamButton: string;
  askAnything: string; composerLabel: string; addAttachment: string;
  voiceInput: string; sendMessage: string; comingSoon: string; suggestions: string[];
};

/** One conversation surface, not a dashboard card around another chat card. */
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
  return <SupervisorChatComposer
    enabled={chatEnabled} unavailableReason={chatUnavailableReason}
    snapshot={snapshot} locale={locale} copy={{ ...copy, ...chatCopy }}
  />;
}
