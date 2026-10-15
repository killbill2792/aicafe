/** Hidden canonical code: generated server-side from the stable idempotency key.
 * The owner only supplies a localized human-readable name, never ASCII IDs.
 */
export function qualificationCodeFromRequestKey(requestKey: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey))
    throw new Error("Invalid qualification request key");
  return "q_" + requestKey.toLowerCase().replaceAll("-","").slice(0,24);
}
