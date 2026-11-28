import "server-only";
import { createWebSearch as createPublicWebSearch, type WebSearchBudget } from "@/lib/connectors/publicWebResearch.server";
import { ownerPublicWebFetch } from "@/lib/connectors/publicWeb.server";
import { requestComposition, type RequestComposition } from "./executionPolicy";

export { extractWebSearchAnswer, webSearchUsage } from "@/lib/connectors/publicWebResearch.server";
export type { WebSearchResult, WebSearchUsage } from "@/lib/connectors/publicWebResearch.server";

type LegacyBudget = WebSearchBudget & {
  onRequestComposition?: (composition: RequestComposition | null) => void;
};
export type { LegacyBudget as WebSearchBudget };

/** Keep the older loop's composition callback while sharing the connector. */
export function createWebSearch(deps: Partial<Parameters<typeof createPublicWebSearch>[0]> = {}) {
  const lookup = createPublicWebSearch({ ...deps, fetch:deps.fetch??ownerPublicWebFetch });
  return (query: string, budget?: LegacyBudget, signal?: AbortSignal) => lookup(query, budget ? {
    ...budget,
    onRequest: request => {
      budget.onRequest?.(request);
      budget.onRequestComposition?.(requestComposition(request));
    },
  } : undefined, signal);
}
export const searchWeb = createWebSearch();
