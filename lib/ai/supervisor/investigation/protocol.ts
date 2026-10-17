import {z} from "zod";
export const stepSchema=z.strictObject({
  action:z.enum(["read","calculate","answer"]),
  capabilityId:z.string().min(1).max(120).nullable(),
  argumentsJson:z.string().min(2).max(8000).nullable(),
  responseJson:z.string().min(2).max(12000).nullable(),
});
export const answerSchema=z.strictObject({
  paragraphs:z.array(z.strictObject({
    kind:z.enum(["evidence","advice","clarification"]),
    text:z.string().min(1).max(1100),
    citations:z.array(z.string().regex(/^r\d+$/)).max(5),
  })).min(1).max(8),
});
export const reviewSchema=z.strictObject({supported:z.boolean(),complete:z.boolean()});
export type InvestigationAnswer=z.infer<typeof answerSchema>;
export const INVESTIGATION_LIMITS={modelCalls:8,operations:5,elapsedMs:90000,
  providerTimeoutMs:18000,totalOutputTokens:16000,observationsBytes:60000} as const;
