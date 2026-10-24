import type { AgentId } from "@/lib/operating/tasks";
export type HomeTaskPreviewItem = { id: string; agentId: AgentId; agentName: string; title: string; href: string };

import { Link } from "@/i18n/navigation";
import { prioritizeHomeAttention, type HomeAttentionItem } from "./homeAttention";

export default function HomeTaskSections({ items, title, empty, seeAll }: {
  items: HomeAttentionItem[]; title: string; empty: string; seeAll: string;
}) {
  const { visible, total } = prioritizeHomeAttention(items);
  return <section aria-labelledby="attention-heading" className="rounded-card-lg border border-line bg-card p-4">
    <div className="flex items-center justify-between gap-3">
      <h2 id="attention-heading" className="font-headline text-2xl font-bold text-ink">{title}</h2>
      {total > 5 && <Link href="/operations" className="inline-flex min-h-12 items-center text-[17px] font-bold text-good underline">{seeAll}</Link>}
    </div>
    {visible.length === 0 ? <p className="py-4 text-[17px] text-ink-muted">{empty}</p> :
      <ul className="mt-3 divide-y divide-line">{visible.map(item =>
        <li key={item.id} className="flex min-h-16 items-center gap-3 py-2">
          <span className="min-w-0 flex-1 text-[17px] font-semibold text-ink">{item.title}</span>
          <Link href={item.href} className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-full bg-good px-4 text-[15px] font-bold text-white no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">{item.actionLabel}</Link>
        </li>)}</ul>}
  </section>;
}
