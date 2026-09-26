import "server-only";
import type { AiChatCompleter } from "../types";

const MODEL = process.env.MOONSHOT_MODEL || "moonshot-v1-8k";
const BASE_URL = process.env.MOONSHOT_BASE_URL || "https://api.moonshot.cn/v1";

/** Moonshot's Kimi API is OpenAI-compatible. */
export const completeWithMoonshot: AiChatCompleter = async ({ system, user, imageDataUrl }) => {
  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) throw new Error("Missing MOONSHOT_API_KEY");
  if (imageDataUrl) {
    // Vision needs a vision-capable Moonshot model (e.g. moonshot-v1-8k-vision-preview) —
    // set MOONSHOT_MODEL accordingly before using receipt reading with this provider.
  }

  const userContent = imageDataUrl
    ? [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: user }]
    : user;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Moonshot API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
  };
};
