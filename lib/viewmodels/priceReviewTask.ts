export function priceReviewDirection(currentPriceCents: number, suggestedPriceCents: number): "low" | "high" {
  return suggestedPriceCents > currentPriceCents ? "low" : "high";
}

export function priceReviewHref(menuItemId: string): string {
  const id = encodeURIComponent(menuItemId);
  return `/menu/${id}?tab=overview&editPrice=${id}`;
}
