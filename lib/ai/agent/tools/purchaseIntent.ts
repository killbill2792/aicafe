/** A saved owner message is an authorization only for an explicit, present purchase command.
 * Attachment text and model tool arguments MUST NOT be passed here. This rejects
 * hypothetical, negated and exploratory language; uncertain cases use approval cards. */
export function authorizesInventoryWrite(ownerText:string,hasAttachments:boolean):boolean{
 const t=ownerText.normalize("NFKC").toLocaleLowerCase().trim();
 if(!t||t.length>4000||t.includes("?")||/\b(if|what if|suppose|maybe|might|could|would|should|hypothetical|preview|draft|review only|do not|don't|never|cancel|not yet|planning|plan to)\b/u.test(t))
  return false;
 const explicit=/\b(record|add|update|log|increase|save|post)\b/u.test(t)&&
   /\b(inventory|stock|purchases?|receipt|bill|invoice|items?)\b/u.test(t);
 const directBought=/\b(i|we)\s+(?:just\s+)?(?:bought|purchased)\s+\d+(?:[.,]\d+)?\s+(?:[a-z]+\s+){1,5}/u.test(t);
 // A naked receipt upload describes evidence; it does not grant permission.
 return explicit||(directBought&&!hasAttachments);
}
