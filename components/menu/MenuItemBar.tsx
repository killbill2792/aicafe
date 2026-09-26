import Money from "@/components/shared/Money";
import type { MenuItemBreakdown } from "@/lib/viewmodels/menuViewModel";

const SEGMENTS: { key: keyof MenuItemBreakdown; color: string }[] = [
  { key: "ingredientsCents", color: "bg-ingredients" },
  { key: "staffTimeCents", color: "bg-staff" },
  { key: "cardFeeCents", color: "bg-fees" },
  { key: "rentBillsShareCents", color: "bg-running" },
];

/** The 5-segment stacked bar from docs/03-screens.md S6 (mockup shows 3; the doc adds card fee + rent share). */
export default function MenuItemBar({ breakdown, tall, yoursLabel }: { breakdown: MenuItemBreakdown; tall?: boolean; yoursLabel: string }) {
  const price = breakdown.item.priceCents;
  const yours = Math.max(0, breakdown.yoursCents);
  const height = tall ? "h-11" : "h-3";

  return (
    <div className={`flex ${height} gap-[3px] overflow-hidden rounded-xl`}>
      {SEGMENTS.map((seg) => {
        const cents = breakdown[seg.key] as number;
        const pct = price === 0 ? 0 : (cents / price) * 100;
        return (
          <div key={seg.key} className={`${seg.color} flex items-center justify-center`} style={{ width: `${pct}%` }}>
            {tall && pct > 12 && <span className="text-[13px] font-bold text-white">{Math.round(cents)}¢</span>}
          </div>
        );
      })}
      <div className="flex flex-1 items-center justify-center bg-good" style={{ minWidth: 0 }}>
        {tall && (
          <span className="whitespace-nowrap text-[15px] font-bold text-white">
            <Money cents={yours} /> {yoursLabel}
          </span>
        )}
      </div>
    </div>
  );
}
