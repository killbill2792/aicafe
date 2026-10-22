export default function EstimatePill({ label, tone = "light" }: { label: string; tone?: "light" | "dark" }) {
  return (
    <span
      className={
        tone === "dark"
          ? "rounded-xl border border-current bg-transparent px-2.5 py-1 text-xs font-bold text-inherit"
          : "rounded-lg bg-warn-tint px-2 py-1 text-[11px] font-extrabold text-warn"
      }
    >
      {label}
    </span>
  );
}
