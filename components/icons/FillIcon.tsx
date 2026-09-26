"use client";

import { useId } from "react";
import type { ExpenseIconCode } from "./ExpenseIconDefs";

/**
 * The fill metaphor (docs/02-design-system.md): an icon fills green from the bottom up as the
 * month's money pays it back. A gradient with two stops at the same offset gives a hard cutoff
 * at exactly `pctCovered` — no clip-path needed, and it reads correctly in RTL since the
 * gradient is vertical (fill direction never mirrors, per the design doc).
 */
export default function FillIcon({
  code,
  pctCovered,
  size = 52,
  hasDetail = true,
  covered = false,
  label,
  className,
}: {
  code: ExpenseIconCode;
  /** 0-100. Ignored (renders fully outlined) if you just want a plain icon — see PlainIcon. */
  pctCovered: number;
  size?: number;
  /** Most icons have white inner details when filled; a few (supplies) use a solid silhouette detail instead. */
  hasDetail?: boolean;
  covered?: boolean;
  label?: string;
  className?: string;
}) {
  const gradientId = useId();
  const pct = Math.max(0, Math.min(100, pctCovered)) / 100;

  return (
    <span className={`relative inline-flex shrink-0 ${className ?? ""}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={label} aria-hidden={label ? undefined : true}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
            <stop offset={pct} stopColor="#1E6B4B" />
            <stop offset={pct} stopColor="#E7DFD3" />
          </linearGradient>
        </defs>
        <use href={`#ic-${code}`} fill={`url(#${gradientId})`} style={hasDetail ? undefined : ({ "--sil": "#2A1D14" } as React.CSSProperties)} />
      </svg>
      {covered && (
        <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border-[3px] border-card bg-good">
          <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
            <use href="#ic-check" />
          </svg>
        </span>
      )}
    </span>
  );
}
