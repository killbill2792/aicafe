import {z} from "zod";
export const stepSchema=z.strictObject({
  action:z.enum(["read","calculate","answer"]),
  capabilityId:z.string().min(1).max(120).nullable(),
  argumentsJson:z.string().min(2).max(8000).nullable(),
  responseJson:z.string().min(2).max(12000).nullable(),
});
/** §4b fallback: a model-proposed "show your work" declaration for ONE
 * freehand numeric claim in a paragraph's prose -- never trusted directly.
 * `claim` is the exact numeric/currency/percent text as it is written in
 * the paragraph (used only to locate which span this entry verifies);
 * `formula` is evaluated under the closed grammar in
 * `lib/calc/formulaExpression.ts`; each variable's `source` is independently
 * resolved (an exact owner-message quote, or a real "rN:path" observation
 * pointer) and its declared `value` is never trusted on its own. */
export const formulaEntrySchema=z.strictObject({
  claim:z.string().min(1).max(40),
  formula:z.string().min(1).max(200),
  variables:z.record(z.string().min(1).max(32),z.strictObject({
    value:z.number(),source:z.string().min(1).max(300),
  })),
});
export type FormulaEntry=z.infer<typeof formulaEntrySchema>;
export const answerSchema=z.strictObject({
  paragraphs:z.array(z.strictObject({
    kind:z.enum(["evidence","advice","clarification"]),
    text:z.string().min(1).max(1100),
    citations:z.array(z.string().regex(/^r\d+$/)).max(5),
    // Present only on a paragraph with one or more freehand numeric claims;
    // one entry per number, so a problem with one never affects the others.
    formulas:z.array(formulaEntrySchema).max(5).optional(),
  })).min(1).max(8),
});
export const reviewSchema=z.strictObject({supported:z.boolean(),complete:z.boolean()});
export type InvestigationAnswer=z.infer<typeof answerSchema>;
/** §5: a narrow, reading-comprehension-only follow-up call that tries to
 * express ONE paragraph's already-written freehand claim as the same
 * {formula,variables} shape as §4b, when the model didn't already supply
 * one. `extracted:null` means it could not be expressed this way -- treated
 * exactly like any other unverifiable number, never a new gate. */
export const formulaExtractionSchema=z.strictObject({extracted:formulaEntrySchema.nullable()});
export const INVESTIGATION_LIMITS={
  // The real binding constraint historically was this call-count ceiling,
  // not elapsed time (every observed production exhaustion stopped on
  // "model_calls", never "time"). The reservation math throughout
  // model.server.ts and runInvestigation.server.ts (answer + independent
  // review + the nested calendar/privacy gates) is tightly coupled to this
  // exact value, so it is NOT simply raised here -- instead,
  // runInvestigation.server.ts's loop now stops the moment a round repeats
  // a prior FAILED attempt with no new information (an unregistered tool
  // name tried again, or the identical already-rejected answer draft),
  // rather than waiting out the remaining calls doing so, and a §5b
  // ask-before-mask retry (a precise, known correction) is always
  // preferred over spending a call on open-ended exploration. This keeps
  // the ceiling itself as only the hard safety cap it always was, never
  // the normal way a turn ends.
  modelCalls:8,operations:5,elapsedMs:90000,
  providerTimeoutMs:18000,totalOutputTokens:16000,observationsBytes:60000} as const;
