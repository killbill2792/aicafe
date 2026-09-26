export default function EstimatePill({ label, tone = "light" }: { label: string; tone?: "light" | "dark" }) {
  return (
    <span
      className={
        tone === "dark"
          ? "rounded-xl bg-white/20 px-2.5 py-1 text-xs font-bold text-white"
          : "rounded-lg bg-warn-tint px-2 py-1 text-[11px] font-extrabold text-warn"
      }
    >
      {label}
    </span>
  );
}
