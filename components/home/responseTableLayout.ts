/** A genuinely wide table reflows into compact labelled rows on narrow
 * screens, retaining every original cell and its accessible table semantics.
 * Used by both native Markdown and structured evidence tables. */
export const wideResponseTableClass="max-sm:block max-sm:[&_colgroup]:hidden max-sm:[&_thead]:sr-only max-sm:[&_tbody]:block max-sm:[&_tbody_tr]:block max-sm:[&_tbody_tr]:border-b max-sm:[&_tbody_tr:last-child]:border-b-0 max-sm:[&_tbody_tr]:py-1";
export const wideResponseCellClass="max-sm:grid max-sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] max-sm:gap-2 max-sm:items-baseline max-sm:border-b-0 max-sm:text-start max-sm:py-1";
export const wideResponseLabelClass="hidden max-sm:block text-[0.8125rem] font-medium leading-snug text-ink-muted [overflow-wrap:anywhere]";
