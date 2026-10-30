"use client";
import type {ChatStartCopy, ChatStartData} from "./ChatStart";
import type {HomeStartPayload} from "./DeferredChatStart";
import type {Period} from "@/lib/viewmodels/period";

import SupervisorChatComposer, { type SupervisorChatCopy } from "./SupervisorChatComposer";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";

type SupervisorCopy = {
  eyebrow: string; heading: string; intro: string; teamButton: string;
  askAnything: string; composerLabel: string; addAttachment: string;
  voiceInput: string; sendMessage: string; comingSoon: string; suggestions: string[];
};

/** One conversation surface, not a dashboard card around another chat card. */
export default function SupervisorHomePanel({
  copy, chatCopy, chatEnabled, chatUnavailableReason, canUseAi=true, locale, languageSwitch, initialThreadId, initialProposalId, chatStartData, chatStartCopy, chatStartPromise, boardPeriod, cafeCurrency,
}: {
  copy: SupervisorCopy;
  cafeCurrency:string|null;
  chatCopy: Omit<SupervisorChatCopy, keyof SupervisorCopy>;
  chatStartData?: ChatStartData;
  chatStartPromise?: Promise<HomeStartPayload | null>;
  boardPeriod?: Period;
  chatStartCopy?: Omit<ChatStartCopy, "suggestions">;
  initialThreadId?:string;initialProposalId?:string;
  languageSwitch?: React.ReactNode;
  chatEnabled: boolean;
  canUseAi?: boolean;
  chatUnavailableReason: SupervisorChatUnavailableReason | null;
  locale: "en" | "es" | "ar";
}) {
  return <SupervisorChatComposer
    // Search-param navigation can reuse this component on Home. A linked proposal
    // must select its own conversation even when a different one is open.
    key={(initialThreadId ?? "new") + ":" + (initialProposalId ?? "")}
    enabled={chatEnabled} canUseAi={canUseAi} unavailableReason={chatUnavailableReason} cafeCurrency={cafeCurrency}
     locale={locale} languageSwitch={languageSwitch}
    initialThreadId={initialThreadId} initialProposalId={initialProposalId} copy={{ ...copy, ...chatCopy }}
    chatStartData={chatStartData} chatStartCopy={chatStartCopy} chatStartPromise={chatStartPromise} boardPeriod={boardPeriod}
  />;
}
