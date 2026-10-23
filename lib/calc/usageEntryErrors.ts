/** Never expose server error identifiers directly to the café owner. */
const errorLabels={
 invalid_quantity:"usageErrorInvalidQuantity",
 invalid_unit:"usageErrorInvalidUnit",
 ingredient_not_found:"usageErrorIngredientNotFound",
 save_failed:"usageErrorSaveFailed",
 sign_in_required:"usageErrorSaveFailed",
 owner_required:"usageErrorSaveFailed",
} as const;
export function usageEntryErrorKey(error:string):string{
 return Object.prototype.hasOwnProperty.call(errorLabels,error)
  ?errorLabels[error as keyof typeof errorLabels]:errorLabels.save_failed;
}
