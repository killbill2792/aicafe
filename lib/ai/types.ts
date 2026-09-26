export type AiProvider = "anthropic" | "openai" | "moonshot";

export type AiUsage = { inputTokens: number; outputTokens: number };

/** A provider adapter turns (system, user[, image]) into raw response text + token usage (never content). */
export type AiChatCompleter = (params: {
  system: string;
  user: string;
  /** data: URL (e.g. "data:image/jpeg;base64,...") for vision tasks like receipt reading. */
  imageDataUrl?: string;
}) => Promise<{ text: string; usage: AiUsage }>;

export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]*)$/);
  if (!match) throw new Error("Expected a base64 data: URL");
  return { mediaType: match[1], base64: match[2] };
}

export function isAiConfigured(): boolean {
  const provider = process.env.AI_PROVIDER;
  if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
  if (provider === "moonshot") return Boolean(process.env.MOONSHOT_API_KEY);
  return Boolean(process.env.ANTHROPIC_API_KEY); // default provider is anthropic
}
