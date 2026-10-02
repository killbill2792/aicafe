export type RenameProductRpc = {
  rpc(name: "rename_menu_product", args: { target_business_id: string; target_menu_item_id: string; new_base_name: string }): PromiseLike<{ data: boolean | null; error: { message: string; code?: string; details?: string | null; hint?: string | null } | null }>;
};

/** Narrow, testable boundary used by the server action. The database RPC performs the grouped
 * update atomically; this function guarantees the authenticated active-business id is passed as
 * the tenant boundary rather than accepting one from the browser. */
export async function executeGroupedProductRename(client: RenameProductRpc, businessId: string, menuItemId: string, name: string) {
  return client.rpc("rename_menu_product", { target_business_id: businessId, target_menu_item_id: menuItemId, new_base_name: name.trim() });
}
