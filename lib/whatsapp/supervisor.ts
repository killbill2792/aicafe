/** Channel translation only. These are prompts for the ONE Supervisor, not an intent router. */
export const WHATSAPP_QUICK_REPLY_QUESTIONS = {
  money_went: "Where did my money go yesterday?",
  peak_today: "What are my usual busiest hours for today?",
  slowest_yesterday: "What was my slowest hour yesterday?",
  event_today: "Tell me more about today's saved nearby event.",
} as const;

export type WhatsAppQuickReplyPayload = keyof typeof WHATSAPP_QUICK_REPLY_QUESTIONS;
export type WhatsAppOwnerInput =
  | { type: "text"; text: string }
  | { type: "button"; payload: string; text?: string }
  | { type: "media"; kind: "image" | "document" }
  | { type: "interactive"; interactive: { type: "button_reply"; button_reply: { id: string; title?: string } } };

export function supervisorQuestionForWhatsApp(input: WhatsAppOwnerInput): string {
  if (input.type === "text") {
    const text = input.text.trim();
    if (!text || text.length > 4000) throw new Error("invalid_whatsapp_owner_text");
    return text;
  }
  // Images can become private, review-only receipt drafts. PDFs are retained
  // unanalysed for web review and must never inspire invented line items.
  if(input.type==="media")
    return input.kind==="image"
      ?"Please review my attached receipt or invoice photo. If the details are legible, prepare only draft purchase lines for my review in AI Cafe. Do not record or approve anything."
      :"I attached a PDF receipt or invoice for private review in AI Cafe. The PDF was saved but not analyzed; please ask me to review its details on the website. Do not infer items, costs or record expenses.";
  // Never match on visible button text or interactive title. Unknown IDs fail closed.
  const payload = input.type === "button" ? input.payload : input.interactive.button_reply.id;
  if (!Object.hasOwn(WHATSAPP_QUICK_REPLY_QUESTIONS, payload))
    throw new Error("unknown_whatsapp_button_payload");
  return WHATSAPP_QUICK_REPLY_QUESTIONS[payload as WhatsAppQuickReplyPayload];
}

/** A freeform WhatsApp reply is allowed only within 24h of a verified inbound
 * owner message, evaluated again immediately before sending, not at enqueue. */
export function withinWhatsAppServiceWindow(inboundAt: string | number | Date, now = new Date()): boolean {
  const timestamp = new Date(inboundAt).getTime();
  const elapsed = now.getTime() - timestamp;
  return Number.isFinite(timestamp) && Number.isFinite(elapsed) && elapsed >= 0 &&
    elapsed < 24 * 60 * 60 * 1000;
}

/** Never silently truncate or rewrite the model's answer. */
export function eligibleWhatsAppTextReply(text: string, inboundAt: string | number | Date, now = new Date()): boolean {
  return Boolean(text.trim()) && Array.from(text).length <= 4096 &&
    withinWhatsAppServiceWindow(inboundAt, now);
}

/** Reconstruct the text exactly as splitAgentText persisted it. Interactive
 * cards stay on the website; never serialize hidden proposal actions into WA.
 * A clarify-only reply is represented by its canonical saved question. */
export function whatsappPlainTextFromSavedBlocks(blocks:readonly unknown[]|null):string|null {
 if(!blocks)return null;
 const text=blocks.flatMap(b=>b&&typeof b==="object"&&
  ["text","warning"].includes(String((b as {type?:unknown}).type))&&typeof (b as {text?:unknown}).text==="string"
    ?[(b as {text:string}).text]:[]);
 if(text.length)return text.join("");
 const clarification=blocks.find(b=>b&&typeof b==="object"&&
   (b as {type?:unknown}).type==="clarify"&&
   typeof (b as {question?:unknown}).question==="string") as {question?:string}|undefined;
 return clarification?.question??null;
}
