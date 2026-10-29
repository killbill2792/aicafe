import "server-only";
import type { z } from "zod";
import { completeWithOpenai } from "./providers/openai";

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * lib/ai/complete(task, input) from docs/06-integrations.md: validates output with zod, retries
 * once on invalid JSON, logs token usage (never the prompt/response content). Temperature 0,
 * always using OpenAI.
 */
export async function completeStructured<T>(params: {
  task: string;
  system: string;
  user: string;
  imageDataUrl?: string;
  schema: z.ZodType<T>;
}): Promise<T> {
  const completer = completeWithOpenai;
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await completer({ system: params.system, user: params.user, imageDataUrl: params.imageDataUrl });
    try {
      const json = JSON.parse(extractJson(text));
      return params.schema.parse(json);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`AI task "${params.task}" did not return valid JSON after retrying once: ${String(lastError)}`);
}
