import "server-only";

// OpenAI Responses transport shared by the two independently owned engines.
// The caller reserves its budget and supplies the serialized request.
export type ResponsesEvent = { type: string; [key: string]: unknown };

export class ProviderAvailabilityError extends Error {
  constructor(readonly reason: string) { super("provider_error"); }
}

export async function* streamResponses(
  model: unknown, serialized: string, signal: AbortSignal, request: typeof fetch = fetch,
): AsyncGenerator<ResponsesEvent> {
  let response:Response;
  try{
    response=await request("https://api.openai.com/v1/responses", {
      method:"POST",signal,headers:{Authorization:"Bearer "+(process.env.OPENAI_API_KEY??""),
        "Content-Type":"application/json"},body:serialized,
    });
  }catch(error){
    console.error("supervisor_provider_transport_failure",{model:String(model ?? "unknown"),
      kind:error instanceof Error?error.name:"unknown"});
    throw error;
  }
  if (!response.ok || !response.body) {
    console.error("supervisor_provider_error",{model:String(model ?? "unknown"),status:response.status});
    if(response.status===404||response.status===429||response.status>=500)
      throw new ProviderAvailabilityError("http_"+response.status);
    throw new Error("provider_error");
  }
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
        try { yield JSON.parse(line.slice(6)) as ResponsesEvent; } catch { /* malformed event does not discard turn */ }
      }
    }
  } finally { reader.releaseLock(); }
}
