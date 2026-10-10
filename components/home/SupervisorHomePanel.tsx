import { Coffee, Sparkles, UsersRound } from "lucide-react";
import SupervisorChatComposer, { type SupervisorChatCopy } from "./SupervisorChatComposer";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import { Link } from "@/i18n/navigation";

type SupervisorCopy = {
  eyebrow: string;
  heading: string;
  intro: string;
  teamButton: string;
  askAnything: string;
  composerLabel: string;
  addAttachment: string;
  voiceInput: string;
  sendMessage: string;
  comingSoon: string;
  suggestions: string[];
};

export default function SupervisorHomePanel({
  copy, chatCopy, chatEnabled, chatUnavailableReason, locale,
}: {
  copy: SupervisorCopy;
  chatCopy: Omit<SupervisorChatCopy, keyof SupervisorCopy>;
  chatEnabled: boolean;
  chatUnavailableReason: SupervisorChatUnavailableReason | null;
  locale: "en" | "es" | "ar";
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-[#D8C8B5] bg-[#F0E5D8] p-5 shadow-[0_18px_48px_rgba(42,29,20,0.08)] md:p-6">
      <div className="grid items-center gap-5 md:grid-cols-[minmax(0,1fr)_210px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex min-h-10 items-center gap-2 rounded-full bg-card/80 px-3 text-sm font-extrabold text-ink">
              <Sparkles aria-hidden="true" size={18} />
              {copy.eyebrow}
            </span>
            <Link
              href="/operations"
              className="flex min-h-12 items-center gap-2 rounded-full bg-ink px-4 text-[15px] font-bold text-paper no-underline shadow-sm transition-transform duration-200 hover:-translate-y-0.5 focus-visible:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transform-none motion-reduce:transition-none"
            >
              <UsersRound aria-hidden="true" size={19} />
              {copy.teamButton}
            </Link>
          </div>

          <h1 className="mt-5 max-w-xl font-headline text-4xl font-bold leading-[1.05] text-ink md:text-5xl">
            {copy.heading}
          </h1>
          <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-ink-muted">{copy.intro}</p>
        </div>

        <div className="flex justify-center md:justify-end" aria-hidden="true">
          <div className="relative flex h-[150px] w-[150px] items-center justify-center md:h-[190px] md:w-[190px]">
            <span className="absolute inset-[5%] rounded-[46%_54%_56%_44%/50%_43%_57%_50%] bg-[#DCC8AD]" />
            <span className="absolute inset-[17%] rounded-[52%_48%_45%_55%/44%_55%_45%_56%] bg-[#FFF8EF] shadow-[0_16px_30px_rgba(42,29,20,0.14)]" />
            <Coffee className="relative z-10 text-[#6F4936]" size={58} strokeWidth={2.2} />
            <Sparkles className="absolute end-[22%] top-[18%] z-10 text-[#B67A22]" size={25} />
          </div>
        </div>
      </div>

      <SupervisorChatComposer
        enabled={chatEnabled}
        unavailableReason={chatUnavailableReason}
        locale={locale}
        copy={{ ...copy, ...chatCopy }}
      />
    </section>
  );
}
