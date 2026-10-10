import { authenticatedConversationContext, ConversationApiError } from "@/lib/ai/conversations/auth.server";
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

/** Authenticated, origin-bound, bounded upload. The original audio is never persisted. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await authenticatedConversationContext();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ConversationApiError(503, "transcription_unavailable");
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
        !Number.isFinite(duration) || duration <= 0 || duration > 60) {
      throw new ConversationApiError(422, "audio_invalid");
    }
    const type = audio.type.split(";")[0].trim().toLowerCase();
    const extension = ALLOWED.get(type);
    if (!extension) throw new ConversationApiError(415, "audio_format_unsupported");
    const upload = new FormData();
    upload.append("model", "gpt-transcribe");
    upload.append("file", audio, "dictation." + extension);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + apiKey },
        body: upload,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new ConversationApiError(502, "transcription_failed");
      const result: unknown = await response.json();
      const text = result && typeof result === "object" && "text" in result &&
        typeof result.text === "string" ? result.text.trim().slice(0, 4000) : "";
      if (!text) throw new ConversationApiError(422, "audio_no_speech");
      return conversationJson({ text });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return conversationError(error);
  }
}
