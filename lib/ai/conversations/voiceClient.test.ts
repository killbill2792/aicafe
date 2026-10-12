import {describe,expect,it} from "vitest";
import {audioExtensionForMime,parseTranscriptionResponse,voiceMessageForError,VoiceTranscriptionError} from "./voiceClient";

const copy={
  voiceNoSpeech:"NO_SPEECH",voiceUnavailable:"UNSUPPORTED",voiceServiceUnavailable:"SERVICE",
  voiceNetworkError:"NETWORK",voiceTooLong:"TOO_LONG",voiceError:"GENERIC",
};

describe("Supervisor voice client contract",()=>{
  it("parses successful editable transcription text",async()=>{
    await expect(parseTranscriptionResponse(new Response(JSON.stringify({text:"hello"}),{status:200})))
      .resolves.toEqual({text:"hello"});
  });
  it.each([
    ["audio_no_speech","NO_SPEECH"],
    ["audio_format_unsupported","UNSUPPORTED"],
    ["audio_too_large","TOO_LONG"],
    ["transcription_network","NETWORK"],
    ["transcription_provider_access","SERVICE"],
    ["transcription_rate_limited","SERVICE"],
    ["transcription_timeout","SERVICE"],
    ["transcription_provider_failure","SERVICE"],
  ] as const)("maps %s to the intended owner message",async(code,message)=>{
    const response=new Response(JSON.stringify({error:code}),{status:503});
    await expect(parseTranscriptionResponse(response)).rejects.toMatchObject({code});
    expect(voiceMessageForError(code,copy)).toBe(message);
  });
  it("fails closed when a response exposes an unknown code or malformed success",async()=>{
    await expect(parseTranscriptionResponse(new Response(JSON.stringify({error:"provider_secret"}),{status:502})))
      .rejects.toEqual(expect.objectContaining({code:"transcription_provider_failure"}));
    await expect(parseTranscriptionResponse(new Response("not-json",{status:200})))
      .rejects.toBeInstanceOf(VoiceTranscriptionError);
  });
  it("preserves real browser MIME instead of guessing an MP4 container",()=>{
    expect(audioExtensionForMime("audio/mp4;codecs=mp4a.40.2")).toBe("mp4");
    expect(audioExtensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtensionForMime("audio/ogg")).toBe("ogg");
    expect(audioExtensionForMime("audio/x-m4a")).toBe("m4a");
    expect(audioExtensionForMime("")).toBeNull();
    expect(audioExtensionForMime("application/octet-stream")).toBeNull();
  });
});
