import type { AIExplanationRequest, AIExplanationResult, AIProvider, AIReasoningRequest, AIReasoningResult } from "../types";

export class NoAIProvider implements AIProvider {
  readonly name = "none";
  async isAvailable(): Promise<boolean> { return false; }
  async reason(input: AIReasoningRequest): Promise<AIReasoningResult> { void input; return { summary: "", proposedToolCalls: [], provider: this.name }; }
  async explain(input: AIExplanationRequest): Promise<AIExplanationResult> {
    return { text: [input.subject, ...input.assumptions].filter(Boolean).join(" — "), provider: this.name };
  }
}
