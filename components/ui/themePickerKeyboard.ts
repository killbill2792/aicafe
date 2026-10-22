/** Navigate theme swatches in visual order, including in RTL layouts. */
export function themeArrowDelta(key: string, direction: "ltr" | "rtl"): -1 | 1 | null {
  if (key === "ArrowDown") return 1;
  if (key === "ArrowUp") return -1;
  if (key === "ArrowRight") return direction === "rtl" ? -1 : 1;
  if (key === "ArrowLeft") return direction === "rtl" ? 1 : -1;
  return null;
}
