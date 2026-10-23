import { ZodError } from "zod";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
import { agentToolDefinitions, agentLabelsPrompt, agentForTool, executeAgentTool, type AgentToolContext, type AgentToolResult } from "./tools";
import { statusFromResults } from "./status";
import { checkNumbers,compactEvidence,type NumericEvidence } from "./checkNumbers";
import { STYLE_RULES } from "./style";

export type EndReason = "complete" | "budget" | "timeout" | "provider_error" | "tool_errors";
type ToolCall = { type: "function_call"; name: string; arguments: string; call_id: string };
type Event = { type: string; [key: string]: unknown };
export type AgentProvider = (params: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<Event>;
export type AgentTurn = { text: string; endReason: EndReason; status: ReturnType<typeof statusFromResults>;
  unverified: ReturnType<typeof checkNumbers>; results: AgentToolResult[]; evidence?: NumericEvidence[]; tools?:string[]; agentIds?:string[];
  usage: { modelCalls: number; toolCalls: number; inputTokens: number; cachedTokens: number; outputTokens: number; latencyMs: number };
  /** Owner messages sent while this turn ran and read by the model before a later step. */
  absorbedOwnerMessageIds?: string[] };
/** A message the owner sent while the turn was running. */
export type OwnerFollowUp = { id: string; text: string };
/** Stable instruction prefix. Style rules are appended (not per-turn data), so the
 * whole prefix stays identical across turns and cafés and is served from cache. */
export function agentInstructions(style: boolean): string {
  return SYSTEM_PROMPT + "\n" + (style ? STYLE_RULES + "\n" : "") + agentLabelsPrompt;
}
export function agentPromptCacheKey(style: boolean): string { return style ? "cafe-agent-v2" : "cafe-agent-v1"; }
export const SYSTEM_PROMPT = "You help an independent cafe owner in their language. Be concise, truthful, helpful. Alex, Leo, Maya and Olivia are names for you; you are one assistant with all tools. Never say you can\'t reach or contact a teammate. Answer staff, schedule, money and supplies questions directly with the tools. Use tools for business facts. Never invent numbers, missing data or completed actions. Ask one specific clarifying question naturally when needed. On incomplete evidence explain what is known and missing. A proposal is not a completed action; say 'I've drafted this for your approval.' No JSON envelope.";

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
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const line = frame.split(/\r?\n/).find(part => part.startsWith("data: "));
        if (!line || line === "data: [DONE]") continue;
        try { yield JSON.parse(line.slice(6)) as Event; } catch { /* malformed event does not discard turn */ }
      }
    }
  } finally { reader.releaseLock(); }
}

export async function runAgentTurn(args: {
  ownerText: string; history?: Array<{ role: "user" | "assistant"; content: string }>;
  context: AgentToolContext; provider?: AgentProvider; onDelta?: (delta: string) => void;
  onReset?: (discardChars: number) => void;
  now?: () => number; onTool?: (name:string,agentId:string)=>void;
  previousEvidence?:readonly NumericEvidence[];
  /** CHAT_STYLE_V2: append STYLE_RULES to the cached instruction prefix. */
  style?: boolean;
  /** CHAT_MEMORY: owner-approved café facts, already capped and formatted. Sent as
   * the first input item (stable per café, so it also caches) — never in instructions. */
  memoryFacts?: string | null;
  /** Extra strict tool definitions enabled by a flag (e.g. the memory tool). */
  extraTools?: readonly unknown[];
  /** CHAT_JOBS: returns up to `max` owner follow-ups not yet read (each exactly once).
   * Called before each later model step; failures are ignored (unread messages then
   * get their own continuation turn). */
  takeFollowUps?: (max: number) => Promise<OwnerFollowUp[]>;
  onFollowUp?: (count: number) => void;
}): Promise<AgentTurn> {
  const now = args.now ?? Date.now, started = now(), deadline = started + 60000;
  const workDeadline = deadline - 12000; // reserve time for the final no-tool answer
  const controller = new AbortController();
  const provider = args.provider ?? openAIProvider;
  const input: unknown[] = [
    ...(args.memoryFacts ? [{ role: "developer", content: args.memoryFacts }] : []),
    ...(args.history ?? []), { role: "user", content: args.ownerText }];
  const absorbed: OwnerFollowUp[] = [];
  // Mark inbox messages answered only when a model response has completed.
  const deliveredIds = new Set<string>();
  // Reads queued owner messages into the conversation before the next model step.
  const readFollowUps = async (): Promise<number> => {
    if (!args.takeFollowUps || absorbed.length >= 5 || now() >= workDeadline) return 0;
    let fresh: OwnerFollowUp[] = [];
    const remaining = workDeadline - now();
    if (remaining <= 0) return 0;
    let inboxTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const messages = await Promise.race([
        args.takeFollowUps(5 - absorbed.length),
        new Promise<never>((_, reject) => {
          inboxTimer = setTimeout(() => reject(new Error("inbox_deadline")), remaining);
        }),
      ]);
      if (now() >= workDeadline) return 0;
      fresh = messages.filter(m => m.text.trim() && !absorbed.some(a => a.id === m.id));
    } catch { return 0; }
    finally { clearTimeout(inboxTimer); }
    for (const message of fresh) {
      absorbed.push(message);
      input.push({ role: "user", content: message.text });
    }
    if (fresh.length) args.onFollowUp?.(fresh.length);
    return fresh.length;
  };
  const results: Array<{callId: string; name: string; arguments: string; result: AgentToolResult}> = [];
  const startedTools: string[] = [];
  const usage = { modelCalls: 0, toolCalls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, latencyMs: 0 };
  let text = "", endReason: EndReason = "complete", failures = 0, finished = false;
  const model = configuredSupervisorModel();
  const request = (final: boolean) => ({
    model, instructions: agentInstructions(Boolean(args.style)),
    tools: [...agentToolDefinitions, ...(args.extraTools ?? [])],
    tool_choice: final ? "none" : "auto", stream: true,
    max_output_tokens: 1200, prompt_cache_key: agentPromptCacheKey(Boolean(args.style)), input,
  });
  const call = async (final: boolean) => {
    const calls: ToolCall[] = [], output: unknown[] = [];
    const callTextStart = text.length;
    let completed = false;
    const remaining = (final ? deadline : workDeadline) - now();
    if (remaining <= 0) throw new Error("deadline");
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      usage.modelCalls++;
      for await (const event of provider(request(final), controller.signal)) {
        if (now() >= (final ? deadline : workDeadline)) throw new Error("deadline");
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
      // A tool-only response is not an answer. Keep those follow-ups unclaimed
      // until a completed text response can be persisted.
      if (!calls.length && text.length > callTextStart)
        for (const message of absorbed) deliveredIds.add(message.id);
      return calls;
    } catch (error) {
      const discardChars = text.length - callTextStart;
      if (discardChars > 0) {
        text = text.slice(0, callTextStart);
        args.onReset?.(discardChars);
      }
      throw error;
    } finally { clearTimeout(timeout); }
  };
  try {
    for (let round = 0; round < 5; round++) {
      if (now() >= workDeadline) { endReason = "timeout"; break; }
      if (round > 0) await readFollowUps();
      let calls: ToolCall[];
      try { calls = await call(false); }
      catch { endReason = now() >= workDeadline || controller.signal.aborted ? "timeout" : "provider_error"; break; }
      if (!calls.length) {
        // The owner added something while this answer streamed: answer it in the
        // same reply (one extra bounded call) instead of silently dropping it.
        if (round < 4 && usage.modelCalls < 5 && await readFollowUps()) {
          if (text && !text.endsWith("\n")) { text += "\n\n"; args.onDelta?.("\n\n"); }
          continue;
        }
        finished = true; break;
      }
      for (let index = 0; index < calls.length; index++) {
        const tool = calls[index];
        if (usage.toolCalls >= 8 || now() >= workDeadline || failures >= 2) {
          endReason = now() >= workDeadline ? "timeout" : failures >= 2 ? "tool_errors" : "budget";
          for (const skipped of calls.slice(index)) {
            const error = endReason === "timeout" ? "deadline_exceeded" : endReason === "tool_errors" ? "tool_errors" : "budget_exceeded";
            input.push({ type: "function_call_output", call_id: skipped.call_id, output: JSON.stringify({ error }) });
            results.push({ callId: skipped.call_id, name: skipped.name, arguments: skipped.arguments,
              result: { source: skipped.name, period: null, missing: [error] } });
          }
          break;
        }
        usage.toolCalls++;
        startedTools.push(tool.name);
        args.onTool?.(tool.name,agentForTool(tool.name));
        let result: AgentToolResult;
        let toolTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([executeAgentTool(tool.name, JSON.parse(tool.arguments), args.context),
            new Promise<never>((_, reject) => {
              const left = workDeadline - now();
              if (left <= 0) reject(new Error("deadline"));
              else toolTimer = setTimeout(() => reject(new Error("deadline")), left);
            })]);
          failures = 0;
        } catch (error) {
          failures++;
          const detail = error instanceof ZodError ? {
            error: "invalid_arguments", issues: error.issues.map(issue => ({ path: issue.path, code: issue.code }))
          } : error instanceof SyntaxError ? { error: "invalid_json" }
            : { error: now() >= workDeadline ? "deadline_exceeded" : "tool_unavailable" };
          result = { source: tool.name, period: null, missing: [String(detail.error)], ...detail };
        } finally { clearTimeout(toolTimer); }
        results.push({ callId: tool.call_id, name: tool.name, arguments: tool.arguments, result });
        input.push({ type: "function_call_output", call_id: tool.call_id, output: JSON.stringify(result) });
        if (now() >= workDeadline || failures >= 2) {
          endReason = now() >= workDeadline ? "timeout" : "tool_errors";
          // Respond to all calls already returned in this response before the next request.
          for (const skipped of calls.slice(index + 1)) {
            input.push({ type: "function_call_output", call_id: skipped.call_id,
              output: JSON.stringify({ error: endReason === "timeout" ? "deadline_exceeded" : "tool_errors" }) });
            results.push({ callId: skipped.call_id, name: skipped.name, arguments: skipped.arguments,
              result: { source: skipped.name, period: null, missing: [endReason === "timeout" ? "deadline_exceeded" : "tool_errors"] } });
          }
          break;
        }
      }
      if (endReason !== "complete") break;
      if (round === 4 || usage.toolCalls >= 8) { endReason = "budget"; break; }
    }
    if (!finished && endReason === "complete") endReason = "budget";
    if (!finished && usage.modelCalls < 6 && now() < deadline) {
      await readFollowUps();
      // Exactly one final no-tool request; never allow another model tool call.
      // Recovery is bounded even after provider disconnect/incomplete response.
      try {
        const finalController = new AbortController();
        const left = deadline - now();
        if (left <= 0) { endReason = "timeout"; }
        else {
          const timeout = setTimeout(() => finalController.abort(), left);
          const finalTextStart = text.length;
          try {
            usage.modelCalls++;
            let completed = false;
            for await (const event of provider(request(true), finalController.signal)) {
              if (event.type === "response.failed" || event.type === "error") throw new Error("provider_error");
              if (now() >= deadline) throw new Error("deadline");
              if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                text += event.delta; args.onDelta?.(event.delta);
              }
              if (event.type === "response.completed") {
                completed = true;
                const u = (event.response as {usage?:{input_tokens?:number;output_tokens?:number;input_tokens_details?:{cached_tokens?:number}}}|undefined)?.usage;
                usage.inputTokens += u?.input_tokens ?? 0; usage.outputTokens += u?.output_tokens ?? 0;
                usage.cachedTokens += u?.input_tokens_details?.cached_tokens ?? 0;
              }
            }
            if (!completed) throw new Error("provider_incomplete");
            if (text.length > finalTextStart)
              for (const message of absorbed) deliveredIds.add(message.id);
          } catch (error) {
            const discardChars = text.length - finalTextStart;
            if (discardChars > 0) {
              text = text.slice(0, finalTextStart);
              args.onReset?.(discardChars);
            }
            throw error;
          } finally { clearTimeout(timeout); }
        }
      } catch { endReason = now() >= deadline ? "timeout" : "provider_error"; }
    }
  } finally { controller.abort(); }
  usage.latencyMs = now() - started;
  const status = statusFromResults(results);
  return { text, endReason, status,
    unverified: checkNumbers(text, [ ...(args.history ?? []).filter(message => message.role === "user").map(message => message.content),
      args.ownerText, ...absorbed.map(m => m.text) ].join("\n"), results.map(r=>r.result), args.context.locale,args.previousEvidence),
    evidence:compactEvidence(results.map(r=>r.result)),
    tools:[...new Set(startedTools)],agentIds:[...new Set(startedTools.map(name=>agentForTool(name)))],
    results: results.map(r => r.result), usage,
    ...(deliveredIds.size ? { absorbedOwnerMessageIds: [...deliveredIds] } : {}) };
}
