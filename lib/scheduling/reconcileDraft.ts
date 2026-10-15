/** When a co-owner deletes a record while a draft is open, its old
 * UUID cannot be submitted as a revision-checked UPDATE. After deliberate
 * user confirmation, turn that particular draft entry into a fresh CREATE.
 * Keep all current IDs for proper revision CAS and preserve draft values.
 */
export function reconcileDeletedDraftIds<T extends { id?: string }>(
  draft: readonly T[], current: readonly { id: string }[],
): T[] {
  const ids=new Set(current.map(row=>row.id));
  return draft.map(row=>{
    if (!row.id || ids.has(row.id)) return {...row};
    const { id: _deletedId, ...data } = row;
    void _deletedId;
    return data as T;
  });
}
