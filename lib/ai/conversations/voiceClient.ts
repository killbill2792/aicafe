export type VoiceTranscriptionCode =
  | "audio_missing"
  | "audio_invalid"
  | "audio_too_large"
  | "audio_format_unsupported"
  | "audio_no_speech"
  | "transcription_unavailable"
  | "transcription_provider_access"
  | "transcription_rate_limited"
  | "transcription_timeout"
  | "transcription_network"
  | "transcription_provider_failure";

const knownCodes = new Set<VoiceTranscriptionCode>([
  "audio_missing","audio_invalid","audio_too_large","audio_format_unsupported","audio_no_speech",
  "transcription_unavailable","transcription_provider_access","transcription_rate_limited",
  "transcription_timeout","transcription_network","transcription_provider_failure",
]);

export class VoiceTranscriptionError extends Error {
  constructor(public readonly code: VoiceTranscriptionCode) {
    super(code);
    this.name = "VoiceTranscriptionError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export async function parseTranscriptionResponse(response: Response): Promise<{ text: string }> {
  let body: unknown = null;
  try { body = await response.json(); } catch { /* invalid provider/app response */ }

  if (!response.ok) {
    const candidate = isRecord(body) && typeof body.error === "string" ? body.error : "";
    const code = knownCodes.has(candidate as VoiceTranscriptionCode)
      ? candidate as VoiceTranscriptionCode
      : "transcription_provider_failure";
    throw new VoiceTranscriptionError(code);
  }

  if (!isRecord(body) || typeof body.text !== "string") {
    throw new VoiceTranscriptionError("transcription_provider_failure");
  }
  return { text: body.text };
}

export function audioExtensionForMime(mimeType: string): "webm"|"mp4"|"ogg"|"wav"|"mp3"|"m4a"|null {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/webm") return "webm";
  if (normalized === "audio/mp4") return "mp4";
  if (normalized === "audio/ogg") return "ogg";
  if (normalized === "audio/wav") return "wav";
  if (normalized === "audio/mpeg") return "mp3";
  if (normalized === "audio/x-m4a") return "m4a";
  return null;
}

export type VoiceErrorCopy = {
  voiceNoSpeech: string;
  voiceUnavailable: string;
  voiceServiceUnavailable: string;
  voiceNetworkError: string;
  voiceTooLong: string;
  voiceError: string;
};

export function voiceMessageForError(code: VoiceTranscriptionCode, copy: VoiceErrorCopy): string {
  if (code === "audio_no_speech") return copy.voiceNoSpeech;
  if (code === "audio_format_unsupported") return copy.voiceUnavailable;
  if (code === "audio_too_large") return copy.voiceTooLong;
  if (code === "transcription_network") return copy.voiceNetworkError;
  if (code === "transcription_unavailable" || code === "transcription_provider_access" ||
      code === "transcription_rate_limited" || code === "transcription_timeout" ||
      code === "transcription_provider_failure") return copy.voiceServiceUnavailable;
  return copy.voiceError;
}
