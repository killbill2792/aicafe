import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { AgentAvatar, agentVisuals } from "@/components/operations/AITeamCard";
import type { AgentId } from "@/lib/operating/tasks";

export type HomeTaskPreviewItem = {
  id: string;
  agentId: AgentId;
  agentName: string;
  title: string;
  href: string;
};

type SectionCopy = {
  title: string;
  empty: string;
  href: string;
  items: HomeTaskPreviewItem[];
  count: number;
};

export default function HomeTaskSections({
  sections,
  seeAll,
}: {
  sections: SectionCopy[];
  seeAll: string;
}) {
  return (
    <section className="grid gap-3 lg:grid-cols-3">
      {sections.map((section) => (
        <article key={section.href} className="rounded-card-lg border border-line bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-lg font-extrabold text-ink">{section.title}</h2>
              <span className="flex min-h-7 min-w-7 items-center justify-center rounded-full bg-[#F1E9DE] px-2 text-sm font-extrabold text-ink">
                {section.count}
              </span>
            </div>
            <Link href={section.href} className="shrink-0 text-sm font-bold text-good underline-offset-4 hover:underline">
              {seeAll}
            </Link>
          </div>

          {section.items.length === 0 ? (
            <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">{section.empty}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {section.items.map((item) => {
                const visual = agentVisuals[item.agentId];
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    className={`flex min-h-[72px] items-center gap-3 rounded-2xl border-s-4 p-3 text-ink no-underline transition-transform duration-200 hover:-translate-y-0.5 focus-visible:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transform-none motion-reduce:transition-none ${visual.border} ${visual.softSurface}`}
                  >
                    <AgentAvatar agentId={item.agentId} size="task" />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm font-extrabold ${visual.accent}`}>{item.agentName}</span>
                      <span className="mt-0.5 block text-[15px] font-semibold leading-snug text-ink">{item.title}</span>
                    </span>
                    <ChevronRight aria-hidden="true" size={20} className="shrink-0 text-ink-muted rtl:rotate-180" />
                  </Link>
                );
              })}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
