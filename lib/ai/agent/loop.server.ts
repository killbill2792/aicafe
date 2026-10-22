import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { agentToolDefinitions, executeAgentTool, type AgentToolContext, type AgentToolResult } from "./tools";
import { statusFromResults } from "./status";
import { checkNumbers } from "./checkNumbers";

export type EndReason = "complete" | "budget" | "timeout" | "provider_error";
type ToolCall = { type: "function_call"; name: string; arguments: string; call_id: string };
type Event = { type: string; [key: string]: unknown };
export type AgentProvider = (params: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<Event>;
export type AgentTurn = { text: string; endReason: EndReason; status: ReturnType<typeof statusFromResults>;
  unverified: ReturnType<typeof checkNumbers>; results: AgentToolResult[];
  usage: { modelCalls: number; toolCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number; latencyMs: number } };
export const SYSTEM_PROMPT = "You help an independent cafe owner in their language. Be concise, truthful, helpful. Use tools for business facts. Never invent numbers, missing data or completed actions. Ask one specific clarifying question naturally when needed. On incomplete evidence explain what is known and missing. No JSON envelope.";

export async function* openAIProvider(params: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<Event> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal, headers: { Authorization: "Bearer " + (process.env.OPENAI_API_KEY ?? ""),
      "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok || !response.body) throw new Error("provider_unavailable");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const line = frame.split("\n").find(part => part.startsWith("data: "));
        if (!line || line === "data: [DONE]") continue;
        try { yield JSON.parse(line.slice(6)) as Event; } catch { /* malformed event does not discard turn */ }
      }
    }
  } finally { reader.releaseLock(); }
}

export async function runAgentTurn(args: {
  ownerText: string; history?: Array<{ role: "user" | "assistant"; content: string }>;
  context: AgentToolContext; provider?: AgentProvider; onDelta?: (delta: string) => void;
  now?: () => number;
}): Promise<AgentTurn> {
  const now = args.now ?? Date.now, started = now(), deadline = started + 60000;
  const controller = new AbortController();
  const provider = args.provider ?? openAIProvider;
  const input: unknown[] = [...(args.history ?? []), { role: "user", content: args.ownerText }];
  const results: Array<{callId: string; result: AgentToolResult}> = [];
  const usage = { modelCalls: 0, toolCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, latencyMs: 0 };
  let text = "", endReason: EndReason = "complete", failures = 0, finished = false;
  const model = configuredSupervisorModel();
  const request = (final: boolean) => ({
    model, instructions: SYSTEM_PROMPT, tools: final ? [] : agentToolDefinitions,
    tool_choice: final ? "none" : "auto", stream: true,
    max_output_tokens: 1200, prompt_cache_key: "cafe-agent-v1", input,
  });
  const call = async (final: boolean) => {
    const calls: ToolCall[] = [], output: unknown[] = [];
    let completed = false;
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("deadline");
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      usage.modelCalls++;
      for await (const event of provider(request(final), controller.signal)) {
        if (now() >= deadline) throw new Error("deadline");
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          text += event.delta;
          args.onDelta?.(event.delta);
        }
        if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
          const item = event.item as { type?: string };
          output.push(item);
          if (item.type === "function_call") calls.push(item as ToolCall);
        }
        if (event.type === "response.completed") {
          completed = true;
          const u = (event.response as { usage?: { input_tokens?: number; output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number } } } | undefined)?.usage;
          usage.inputTokens += u?.input_tokens ?? 0;
          usage.outputTokens += u?.output_tokens ?? 0;
          usage.cachedTokens += u?.input_tokens_details?.cached_tokens ?? 0;
        }
        if (event.type === "response.failed" || event.type === "error") throw new Error("provider_error");
      }
      if (!completed) throw new Error("provider_incomplete");
      input.push(...output);
      return calls;
    } finally { clearTimeout(timeout); }
  };
  try {
    for (let round = 0; round < 6; round++) {
      if (now() >= deadline) { endReason = "timeout"; break; }
      let calls: ToolCall[];
      try { calls = await call(false); }
      catch { endReason = now() >= deadline || controller.signal.aborted ? "timeout" : "provider_error"; break; }
      if (!calls.length) { finished = true; break; }
      for (const tool of calls) {
        if (usage.toolCalls >= 8 || now() >= deadline) { endReason = now() >= deadline ? "timeout" : "budget"; break; }
        usage.toolCalls++;
        let result: AgentToolResult;
        try {
          result = await Promise.race([executeAgentTool(tool.name, JSON.parse(tool.arguments), args.context),
            new Promise<never>((_, reject) => { const left = deadline - now();
              if (left <= 0) reject(new Error("deadline"));
              else { const timer = setTimeout(() => reject(new Error("deadline")), left);
                controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true }); }
            })]);
          failures = 0;
        } catch {
          failures++;
          result = { source: tool.name, period: null, labels: {}, missing: ["toolUnavailable"], error: "tool_unavailable" };
        }
        results.push({ callId: tool.call_id, result });
        input.push({ type: "function_call_output", call_id: tool.call_id, output: JSON.stringify(result) });
        if (failures >= 2) { endReason = "budget"; break; }
      }
      if (endReason !== "complete") break;
      if (round === 5 || usage.toolCalls >= 8) { endReason = "budget"; break; }
    }
    if (!finished && endReason === "complete") endReason = "budget";
    if (!finished) {
      // Exactly one final no-tool request; never allow another model tool call.
      // On provider failure, already-streamed text remains intact.
      try {
        controller.abort(); // clear any previous operation
        const finalController = new AbortController();
        const left = deadline - now();
        if (left <= 0) { endReason = "timeout"; }
        else {
          const timeout = setTimeout(() => finalController.abort(), left);
          try {
            usage.modelCalls++;
            for await (const event of provider(request(true), finalController.signal)) {
              if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                text += event.delta; args.onDelta?.(event.delta);
              }
              if (event.type === "response.completed") {
                const u = (event.response as {usage?:{input_tokens?:number;output_tokens?:number;input_tokens_details?:{cached_tokens?:number}}}|undefined)?.usage;
                usage.inputTokens += u?.input_tokens ?? 0; usage.outputTokens += u?.output_tokens ?? 0;
                usage.cachedTokens += u?.input_tokens_details?.cached_tokens ?? 0;
              }
            }
          } finally { clearTimeout(timeout); }
        }
      } catch { endReason = now() >= deadline ? "timeout" : "provider_error"; }
    }
  } finally { controller.abort(); }
  usage.latencyMs = now() - started;
  const status = statusFromResults(results);
  return { text, endReason, status,
    unverified: checkNumbers(text, args.ownerText, results.map(r => r.result), args.context.locale),
    results: results.map(r => r.result), usage };
}
