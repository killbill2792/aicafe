/** Which alerts the owner can act on. A "data gap" is only the owner's to fix when it asks for something the owner
 * holds (wage rates, ingredient prices, stock counts, expense receipts). A reader outage, an import that has not
 * landed yet, or a coverage gap that only the system can close is a system condition: it stays recorded for the
 * health check but is never shown as an alert, never turned into a notice or chat message, and never investigated.
 * The same list is enforced in the database by supervisor_alert_owner_actionable (kept in sync by a test). */
export const OWNER_INPUT_GAP_SUBJECTS=["actual_wage_coverage","ingredient_prices","stock_counts","expense_coverage"] as const;

export function isOwnerActionableAlert(kind:string,payload:unknown):boolean{
  if(kind!=="business_anomaly")return true;
  if(!payload||typeof payload!=="object"||Array.isArray(payload))return true;
  const fact=payload as Record<string,unknown>;
  if(fact.family!=="data_gap")return true;
  return typeof fact.subject==="string"&&(OWNER_INPUT_GAP_SUBJECTS as readonly string[]).includes(fact.subject);
}
