import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
import { readSafeProviderError } from "@/lib/ai/conversations/diagnostics.server";
import { conversationError, conversationJson, requireSameOrigin } from "@/lib/ai/conversations/http.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + 16384;
const ALLOWED = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/x-m4a", "m4a"],
]);
const ACCESS_CODES = new Set(["model_not_found","model_access_denied","model_not_available","model_not_accessible"]);
const safeIdentifier=(value:unknown):string|undefined=>{
  if(typeof value!=="string")return undefined;
  const limited=value.slice(0,80);
  return /^[a-zA-Z0-9_.-]+$/.test(limited)?limited:undefined;
};
function safeModel(value:string){
  return value.replace(/[^a-zA-Z0-9_.-]/g,"").slice(0,80);
}
function emitDiagnostic(meta:{
  stage:"provider_request"|"provider_response";model:string;attempt:number;
  category?:string;httpStatus?:number;providerErrorType?:string;
  providerErrorCode?:string;providerRequestId?:string;timeout?:boolean;
}){
  console.info(JSON.stringify({
    event:"supervisor_transcription",
    stage:meta.stage,
    model:safeModel(meta.model),
    attempt:meta.attempt,
    ...(meta.category?{category:safeIdentifier(meta.category)}:{}),
    ...(Number.isSafeInteger(meta.httpStatus)?{httpStatus:meta.httpStatus}:{}),
    ...(safeIdentifier(meta.providerErrorType)?{providerErrorType:safeIdentifier(meta.providerErrorType)}:{}),
    ...(safeIdentifier(meta.providerErrorCode)?{providerErrorCode:safeIdentifier(meta.providerErrorCode)}:{}),
    ...(safeIdentifier(meta.providerRequestId)?{providerRequestId:safeIdentifier(meta.providerRequestId)}:{}),
    ...(meta.timeout?{timeout:true}:{}),
  }));
}
function transientStatus(status:number){
  return status===408||status===409||status===429||status>=500;
}
function providerCode(status:number,providerErrorCode?:string){
  if(status===401||status===403||ACCESS_CODES.has(providerErrorCode??""))return "transcription_provider_access";
  if(status===429)return "transcription_rate_limited";
  if(status===408)return "transcription_timeout";
  return "transcription_provider_failure";
}

/** Authenticated, origin-bound, bounded upload. The original audio is never persisted. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await authenticatedConversationContext();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConversationApiError(503, "transcription_unavailable");
    const model=(process.env.SUPERVISOR_TRANSCRIPTION_MODEL?.trim()||"gpt-transcribe").slice(0,80);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      throw new ConversationApiError(415, "audio_format_unsupported");
    }
    const declared = Number(request.headers.get("content-length"));
    if (declared > MAX_BODY_BYTES) throw new ConversationApiError(413, "audio_too_large");

    // Read with a strict cap BEFORE calling formData(), preventing unbounded memory allocation.
    const reader = request.body?.getReader();
    if (!reader) throw new ConversationApiError(400, "audio_missing");
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ConversationApiError(413, "audio_too_large");
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new ArrayBuffer(total);
    const bytes = new Uint8Array(combined);
    let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
    const body = new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type")! },
      body: new Blob([combined]),
    });
    const form = await body.formData();
    const audio = form.get("audio");
    const duration = Number(form.get("durationSeconds"));
    if (!(audio instanceof File) || !audio.size || audio.size > MAX_AUDIO_BYTES ||
        !Number.isFinite(duration) || duration <= 0) {
      throw new ConversationApiError(422, "audio_invalid");
    }
    if(duration>60)throw new ConversationApiError(413,"audio_too_large");
    const type = audio.type.split(";")[0].trim().toLowerCase();
    const extension = ALLOWED.get(type);
    if (!extension) throw new ConversationApiError(415, "audio_format_unsupported");

    for(let attempt=1;attempt<=2;attempt++){
      const upload = new FormData();
      upload.append("model", model);
      upload.append("file", audio, "dictation." + extension);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      emitDiagnostic({stage:"provider_request",model,attempt});
      try {
        let response:Response;
        try{
          response=await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { authorization: "Bearer " + apiKey },
            body: upload,
            signal: controller.signal,
            cache: "no-store",
          });
        }catch(error){
          const timedOut=controller.signal.aborted||(error instanceof Error&&
            (error.name==="AbortError"||error.name==="TimeoutError"));
          emitDiagnostic({stage:"provider_response",model,attempt,
            category:timedOut?"transcription_timeout":"transcription_network",timeout:timedOut});
          if(attempt===1)continue;
          throw new ConversationApiError(timedOut?504:503,
            timedOut?"transcription_timeout":"transcription_network");
        }
        if(!response.ok){
          const safe=await readSafeProviderError(response);
          const code=providerCode(response.status,safe.providerErrorCode);
          emitDiagnostic({stage:"provider_response",model,attempt,category:code,
            httpStatus:response.status,...safe});
          if(transientStatus(response.status)&&attempt===1)continue;
          throw new ConversationApiError(
            code==="transcription_timeout"?504:code==="transcription_provider_failure"?502:503,
            code,
          );
        }
        let result:unknown;
        try{result=await response.json();}
        catch{
          emitDiagnostic({stage:"provider_response",model,attempt,
            category:"transcription_provider_failure",httpStatus:response.status});
          throw new ConversationApiError(502,"transcription_provider_failure");
        }
        emitDiagnostic({stage:"provider_response",model,attempt,httpStatus:response.status});
        const text = result && typeof result === "object" && "text" in result &&
          typeof result.text === "string" ? result.text.trim().slice(0, 4000) : "";
        if (!text) throw new ConversationApiError(422, "audio_no_speech");
        return conversationJson({ text });
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ConversationApiError(502,"transcription_provider_failure");
  } catch (error) {
    return conversationError(error);
  }
}
