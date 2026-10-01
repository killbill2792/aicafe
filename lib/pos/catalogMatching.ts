import type { PosCatalogItem, PosProvider } from "./types";

export type CanonicalMenuCandidate = { id: string; name: string; sizeLabel: string | null; priceCents: number | null; category: string | null; posItemId: string | null };
export type CatalogMatch = { imported: PosCatalogItem; candidateId: string | null; score: number; status: "matched" | "needs_review" | "new" };

const normalize = (value: string | null) => (value ?? "").toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/** Pure, conservative matcher: exact external ids win; ambiguous name matches always need review. */
export function matchCatalogItem(imported: PosCatalogItem, candidates: CanonicalMenuCandidate[]): CatalogMatch {
  const external = candidates.find((candidate) => candidate.posItemId === imported.posItemId);
  if (external) return { imported, candidateId: external.id, score: 1, status: "matched" };
  const name = normalize(imported.name);
  const scored = candidates.map((candidate) => {
    let score = normalize(candidate.name) === name ? 0.6 : 0;
    if (imported.priceCents !== null && candidate.priceCents === imported.priceCents) score += 0.2;
    if (normalize(imported.category) && normalize(candidate.category) === normalize(imported.category)) score += 0.1;
    return { candidate, score };
  }).filter((entry) => entry.score >= 0.6).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { imported, candidateId: null, score: 0, status: "new" };
  const best = scored[0];
  const unambiguous = best.score >= 0.8 && (scored.length === 1 || best.score > scored[1].score);
  return { imported, candidateId: best.candidate.id, score: best.score, status: unambiguous ? "matched" : "needs_review" };
}

export function catalogSourceFor(provider: PosProvider): "csv" | "square" | "toast" | "clover" | "other_pos" {
  if (provider === "demo") return "other_pos";
  return provider;
}
