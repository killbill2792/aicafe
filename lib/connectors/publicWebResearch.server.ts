import "server-only";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { ownerPublicWebFetch, PublicWebPermissionError } from "./publicWeb.server";
import { publicResearchIncludesPrivateValue, publicWebResearchInstructions } from "./publicWebResearch";

type Source = { title: string; url: string };
type Answer = { answer: string; sources: Source[] };
export type WebSearchResult =
  | ({ available: true } & Answer & { status?: "partial"; reason?: "outputLimit" })
  | { available: false; reason: "notConfigured" | "timeout" | "providerFailed" | "unreadable" |
      "outputLimit" | "unverified" | "budget" | "permissionDenied" | "permissionsUnavailable" | "unsafeQuery" };

type ResponseRecord = Record<string, unknown>;
type Outcome = "completed" | "incomplete" | "failed";
type Reservation = {
  launched: () => void;
  complete: (response: ResponseRecord) => Promise<void>;
};
export type WebSearchUsage = { inputTokens: number; cachedTokens: number; outputTokens: number };
export type WebSearchBudget = {
  reserveModelCall: () => boolean;
  recordUsage: (usage: WebSearchUsage) => void;
  onProviderResponse?: (response: unknown) => void;
  onRequest?: (request: ResponseRecord) => void;
  outputCap?: number | null;
  reserveTransport?: (request: ResponseRecord) => Promise<Reservation | null>;
};
type Dependencies = {
  fetch?: typeof fetch;
  apiKey?: string;
  model?: string;
  now?: () => number;
  reserveTransport?: (request: ResponseRecord) => Promise<(response: unknown, outcome?: Outcome) => Promise<void>>;
};

const record = (value: unknown): ResponseRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ResponseRecord : undefined;
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function webSearchUsage(body: unknown): WebSearchUsage {
  const usage = record(record(body)?.usage);
  return { inputTokens: tokens(usage?.input_tokens), outputTokens: tokens(usage?.output_tokens),
    cachedTokens: tokens(record(usage?.input_tokens_details)?.cached_tokens) };
}

function citation(value: ResponseRecord | undefined): Source | null {
  if (value?.type !== "url_citation" || typeof value.url !== "string") return null;
  try {
    const url = new URL(value.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    return { title: title || url.hostname, url: url.href };
  } catch { return null; }
}

function readAnswer(body: ResponseRecord): Answer | null {
  const sources = new Map<string, Source & { index:number }>();
  const paragraphs: string[] = [];
  for (const item of rows(body.output)) {
    if (item?.type !== "message") continue;
    for (const part of rows(item.content)) {
      if (part?.type !== "output_text" || typeof part.text !== "string" || !part.text.trim()) continue;
      const links = new Set<string>();
      for (const annotation of rows(part.annotations)) {
        const source = citation(annotation);
        if (!source) continue;
        if (!sources.has(source.url)) sources.set(source.url, {...source,index:sources.size+1});
        if (!part.text.includes("]("+source.url) && !part.text.includes("](<"+source.url+">")) links.add(source.url);
      }
      // Native text usually carries inline Markdown links. An annotation-only
      // citation still has a clickable link when a client renders the text.
      const references = [...links].map(url => {
        const index = sources.get(url)?.index;
        return `[${index}](<${url.replace(/[<>]/gu, encodeURIComponent)}>)`;
      });
      paragraphs.push([part.text.trim(), ...references].join(" "));
    }
  }
  return paragraphs.length ? { answer: paragraphs.join("\n\n"), sources: [...sources.values()].map(({title,url})=>({title,url})) } : null;
}

export function extractWebSearchAnswer(body: unknown): Answer | null {
  const response = record(body);
  return response && (response.status === undefined || response.status === "completed") ? readAnswer(response) : null;
}

export function createWebSearch(deps: Dependencies = {}) {
  const doFetch = deps.fetch ?? ownerPublicWebFetch;
  const now = deps.now ?? Date.now;
  return async (query: string, budget?: WebSearchBudget, signal?: AbortSignal): Promise<WebSearchResult> => {
    if (signal?.aborted) return { available: false, reason: "timeout" };
    if (!query.trim() || publicResearchIncludesPrivateValue(query)) return { available: false, reason: "unsafeQuery" };
    const key = deps.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) return { available: false, reason: "notConfigured" };
    const cap = budget?.outputCap === undefined ? (budget ? 1200 : null) : budget.outputCap;
    const request = {
      model: deps.model ?? configuredSupervisorModel(),
      store: false,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      instructions: publicWebResearchInstructions,
      input: query,
      ...(cap === null ? {} : { max_output_tokens: cap }),
    };
    const started = now();
    const elapsed = () => now() - started;
    try {
      budget?.onRequest?.(request);
      const finish = await deps.reserveTransport?.(request);
      const reservation = await budget?.reserveTransport?.(request);
      signal?.throwIfAborted();
      if (budget && !budget.reserveModelCall()) return { available: false, reason: "budget" };
      reservation?.launched();
      const response = await doFetch("https://api.openai.com/v1/responses", {
        method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        console.error("agent_web_search_failed", { category: "http", status: response.status, durationMs: elapsed() });
        return { available: false, reason: "providerFailed" };
      }
      const body = record(await response.json());
      if (!body) return { available: false, reason: "unreadable" };
      const outcome = body.status === "completed" ? "completed" : body.status === "incomplete" ? "incomplete" : "failed";
      budget?.recordUsage(webSearchUsage(body));
      budget?.onProviderResponse?.(body);
      await finish?.(body, outcome);
      if (body.usage) await reservation?.complete(body);
      const outputLimited = outcome === "incomplete" && record(body.incomplete_details)?.reason === "max_output_tokens";
      const searched = rows(body.output).some(item => item?.type === "web_search_call" && item.status === "completed");
      const answer = outcome === "completed" || outputLimited ? readAnswer(body) : null;
      if (searched && answer?.sources.length) {
        console.info("agent_web_search_completed", { outcome, durationMs: elapsed(), sources: answer.sources.length });
        return outputLimited ? { available: true, ...answer, status: "partial", reason: "outputLimit" } : { available: true, ...answer };
      }
      const reason = outputLimited ? "outputLimit" : outcome !== "completed" ? "providerFailed" : answer ? "unverified" : "unreadable";
      console.error("agent_web_search_failed", {
        category: reason, outcome, durationMs: elapsed(),
        outputTokens: webSearchUsage(body).outputTokens,
        reasoningTokens: tokens(record(record(body.usage)?.output_tokens_details)?.reasoning_tokens),
      });
      return { available: false, reason };
    } catch (error) {
      if (error instanceof PublicWebPermissionError) return { available: false, reason: error.reason };
      if (error instanceof Error && /^(durable_|owner_quota_reached|storage_failed)/u.test(error.message)) throw error;
      const timedOut = signal?.aborted || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      console.error("agent_web_search_failed", { category: timedOut ? "timeout" : "network", durationMs: elapsed() });
      return { available: false, reason: timedOut ? "timeout" : "providerFailed" };
    }
  };
}
export const searchWeb = createWebSearch();
