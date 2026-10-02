/** The one canonical stored-name rule for every size belonging to an owner-facing product. */
export function productSizeName(baseName: string, sizeLabel: string | null | undefined): string {
  const name = baseName.trim();
  const size = sizeLabel?.trim();
  return size ? `${name} ${size}` : name;
}

export function renamedProductSizes<T extends { sizeLabel?: string | null }>(siblings: T[], newBaseName: string) {
  return siblings.map((sibling) => ({ ...sibling, baseName: newBaseName.trim(), name: productSizeName(newBaseName, sibling.sizeLabel) }));
}
