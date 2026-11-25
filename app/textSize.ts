/** Owner-chosen text size. Every font size is rem-based, so one root percentage scales the whole app. */
export const TEXT_SIZES = ["small", "default", "large", "xlarge"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DEFAULT_TEXT_SIZE: TextSize = "default";
export function parseTextSizeCookie(value: string | null | undefined): TextSize {
  return TEXT_SIZES.some((size) => size === value) ? value as TextSize : DEFAULT_TEXT_SIZE;
}
