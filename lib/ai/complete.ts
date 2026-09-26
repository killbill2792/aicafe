import "server-only";
import type { z } from "zod";
import { completeWithAnthropic } from "./providers/anthropic";
import { completeWithOpenai } from "./providers/openai";
import { completeWithMoonshot } from "./providers/moonshot";
import type { AiChatCompleter, AiProvider } from "./types";

function getCompleter(): AiChatCompleter {
  const provider = (process.env.AI_PROVIDER as AiProvider) || "anthropic";
  if (provider === "openai") return completeWithOpenai;
  if (provider === "moonshot") return completeWithMoonshot;
  return completeWithAnthropic;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * lib/ai/complete(task, input) from docs/06-integrations.md: validates output with zod, retries
 * once on invalid JSON, logs token usage (never the prompt/response content). Temperature 0,
 * whichever provider AI_PROVIDER selects.
 */
export async function completeStructured<T>(params: {
  task: string;
  system: string;
  user: string;
  imageDataUrl?: string;
  schema: z.ZodType<T>;
}): Promise<T> {
  const completer = getCompleter();
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await completer({ system: params.system, user: params.user, imageDataUrl: params.imageDataUrl });
    console.log(
      `[ai] task=${params.task} provider=${process.env.AI_PROVIDER || "anthropic"} attempt=${attempt + 1} inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens}`,
    );
    try {
      const json = JSON.parse(extractJson(text));
      return params.schema.parse(json);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`AI task "${params.task}" did not return valid JSON after retrying once: ${String(lastError)}`);
}
