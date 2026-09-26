import "server-only";
import { parseDataUrl, type AiChatCompleter } from "../types";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

export const completeWithAnthropic: AiChatCompleter = async ({ system, user, imageDataUrl }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const content: unknown[] = [];
  if (imageDataUrl) {
    const { mediaType, base64 } = parseDataUrl(imageDataUrl);
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } });
  }
  content.push({ type: "text", text: user });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      temperature: 0,
      system,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.content?.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : "")).join("") ?? "";
  return { text, usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 } };
};
