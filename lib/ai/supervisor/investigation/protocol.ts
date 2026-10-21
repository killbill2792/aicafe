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
  // An ARRAY of named declarations, never a map keyed by variable name
  // (production bug): a record's dynamic keys have no fixed `properties`,
  // which OpenAI's structured-output strict JSON Schema mode rejects
  // outright (every real owner question failed with a provider 400
  // "invalid_json_schema" the moment this field existed in the schema at
  // all -- never a model-authoring failure, a request-shape failure).
  // Capped at the evaluator's own MAX_VARIABLES (formulaExpression.ts).
  variables:z.array(z.strictObject({
    name:z.string().min(1).max(32),value:z.number(),source:z.string().min(1).max(300),
  })).min(1).max(8),
});
export type FormulaEntry=z.infer<typeof formulaEntrySchema>;
export const answerSchema=z.strictObject({
  paragraphs:z.array(z.strictObject({
    kind:z.enum(["evidence","advice","clarification"]),
    text:z.string().min(1).max(1100),
    citations:z.array(z.string().regex(/^r\d+$/)).max(5),
    // Present only on a paragraph with one or more freehand numeric claims;
    // one entry per number, so a problem with one never affects the others.
    // `nullish` (not just `optional`): OpenAI's structured-output strict
    // mode requires every declared property to be sent back by the model,
    // so the request-building step (model.server.ts) always marks this
    // field required-but-nullable on the WIRE schema regardless of zod's
    // own optionality here -- our own parse of the model's actual response
    // must therefore accept an explicit `null` (a real paragraph with
    // nothing to verify), not only an omitted key.
    formulas:z.array(formulaEntrySchema).max(5).nullish(),
  })).min(1).max(8),
});
// `reason` is mandatory (never optional) so the independent reviewer's
// verdict is never a bare, unexplained pass/fail again: before this field
// existed, a `supported:false`/`complete:false` discarded the WHOLE draft
// with no record anywhere of WHICH claim or goal the reviewer judged
// against -- every retry repeated the same generic feedback, burning the
// call budget with nothing more specific to correct (production incident:
// two otherwise-clean, well-cited drafts were rejected and exhausted with
// no way to tell why from the logs alone).
export const reviewSchema=z.strictObject({supported:z.boolean(),complete:z.boolean(),
  reason:z.string().min(1).max(300),
  // Untrusted prose stays diagnostic-only. This bounded category is used
  // solely to select an owner-locale, preauthored incomplete-goal label.
  missingGoalDomain:z.enum(["menu","pricing","scheduling","staff","sales","expenses","other"]).nullish(),
  // Distinct from missingGoalDomain (null when review is complete): the
  // reviewer must affirm which owner goal a clarification actually concerns.
  // Neither a prior read nor the question text itself may grant a domain.
  clarificationGoalDomain:z.enum(["menu","pricing","scheduling","staff","sales","expenses","other"]).nullish(),
  // Per-paragraph semantic confirmation lets a negative overall verdict
  // preserve unrelated, render-validated narrative without trusting cited
  // action claims. nullish accepts older replies; absent indexes fail closed.
  supportedParagraphIndices:z.array(z.number().int().min(0).max(7)).max(8).nullish(),
});
// Named explicitly (rather than inferred inline at each call site): giving
// `review`/`rescueReview`/`accReview` an explicit annotation in
// runInvestigation.server.ts avoids TypeScript's control-flow narrowing
// re-deriving this union's shape from scratch at every `.reason`/`.supported`/
// `.complete` access -- repeating that enough times in one function body
// (once `reason` added a third narrowing of the same union) tipped an
// internal inference limit and produced spurious "implicitly any, declared
// in its own initializer" errors with no actual circular reference.
export type ReviewVerdict=z.infer<typeof reviewSchema>;
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
