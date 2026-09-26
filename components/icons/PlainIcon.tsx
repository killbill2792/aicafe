import type { ExpenseIconCode } from "./ExpenseIconDefs";

/** A plain, solid-color icon (no fill animation) — for legends, tiles, and non-recovery screens. */
export default function PlainIcon({
  code,
  size = 24,
  color = "currentColor",
  detailColor = "#fff",
  label,
  className,
}: {
  code: ExpenseIconCode;
  size?: number;
  color?: string;
  detailColor?: string;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
      style={{ "--detail": detailColor, "--sil": color } as React.CSSProperties}
    >
      <use href={`#ic-${code}`} fill={color} />
    </svg>
  );
}
