/** Finds the immutable photo anchor already stored for any member of a product family.
 * A newly-added sibling can sort before the original UUID without changing this result. */
export function existingProductPhotoAnchor(
  siblingMenuItemIds: readonly string[],
  photoAnchors: readonly string[],
): string | null {
  const siblings = new Set(siblingMenuItemIds);
  return photoAnchors.find((anchor) => siblings.has(anchor)) ?? null;
}
