import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only",()=>({}));
const settings = vi.hoisted(() => ({ denied: false, expired: false, calls: 0, checks: 0 }));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class ConversationApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
  authenticatedConversationContext: async () => {
    if (settings.denied) throw new Error("owner required");
    return { scope: { ownerUserId: "test-owner", businessId: "test-cafe" } };
  },
}));
vi.mock("@/lib/access/access.server",()=>({
  assertCafeAiAccess:async(id:string)=>{
    expect(id).toBe("test-cafe");
    settings.checks++;
    if(settings.expired){
      const {ConversationApiError}=await import("@/lib/ai/conversations/auth.server");
      throw new ConversationApiError(403,"access_expired");
    }
  },
}));
import { POST } from "./route";

type Provider = (url:string|URL|Request,init?:RequestInit)=>Promise<Response>;
let provider:Provider;

function audioRequest(origin = "https://cafe.example",type="audio/webm") {
  const body = new FormData();
  body.append("audio", new File(["test audio content"], type.includes("mp4")?"dictation.mp4":"dictation.webm", { type }));
  body.append("durationSeconds", "4");
  return new Request("https://cafe.example/api/ai/transcribe", {
    method: "POST", headers: { origin }, body,
  });
}
const ok=()=>new Response(JSON.stringify({ text: " How much did we make today? " }), {
  status: 200, headers: { "content-type": "application/json" },
});
const providerError=(status:number,code:string,message="sensitive provider message")=>
  new Response(JSON.stringify({error:{type:"invalid_request_error",code,message}}),{
    status,headers:{"content-type":"application/json","x-request-id":"req_safe123"},
  });

beforeEach(() => {
  settings.denied = false; settings.expired=false;settings.checks=0;settings.calls = 0;
  process.env.OPENAI_API_KEY = "test-server-key";
  delete process.env.SUPERVISOR_TRANSCRIPTION_MODEL;
  provider=async(url,init)=>{
    expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init?.body as FormData).get("model")).toBe("gpt-transcribe");
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
    expect(init?.headers).toEqual({ authorization: "Bearer test-server-key" });
    return ok();
  };
  vi.stubGlobal("fetch",vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    settings.calls++;
    return provider(url,init);
  }));
  vi.spyOn(console,"info").mockImplementation(()=>{});
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY; delete process.env.SUPERVISOR_TRANSCRIPTION_MODEL;
});

describe("private bounded Supervisor dictation", () => {
  it("denies expired or paused café before reading audio or spending provider credits",async()=>{
    settings.expired=true;
    const response=await POST(audioRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({error:"access_expired"});
    expect(settings.checks).toBe(1);
    expect(settings.calls).toBe(0);
  });
  it("uses the dedicated default gpt-transcribe model and returns editable transcript", async () => {
    const response = await POST(audioRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "How much did we make today?" });
    expect(settings.calls).toBe(1);
  });
  it("honors a dedicated transcription model override without touching Supervisor reasoning models",async()=>{
    process.env.SUPERVISOR_TRANSCRIPTION_MODEL="gpt-4o-mini-transcribe";
    provider=async(_url,init)=>{
      expect((init?.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
      return ok();
    };
    expect((await POST(audioRequest())).status).toBe(200);
  });
  it("accepts Safari-compatible MP4 audio",async()=>{
    expect((await POST(audioRequest("https://cafe.example","audio/mp4"))).status).toBe(200);
  });
  it("returns audio_no_speech only after a successful provider response with no transcript",async()=>{
    provider=async()=>new Response(JSON.stringify({text:"   "}),{status:200});
    const response=await POST(audioRequest());
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({error:"audio_no_speech"});
    expect(settings.calls).toBe(1);
  });
  it("diagnoses 403 model access safely and never mislabels it as no speech",async()=>{
    provider=async()=>providerError(403,"model_not_found","SECRET provider body text");
    const response=await POST(audioRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:"transcription_provider_access"});
    expect(settings.calls).toBe(1);
    const logs=vi.mocked(console.info).mock.calls.flat().join("\n");
    expect(logs).toContain("model_not_found");
    expect(logs).toContain("req_safe123");
    expect(logs).toContain("gpt-transcribe");
    expect(logs).not.toContain("SECRET provider body text");
    expect(logs).not.toContain("test audio content");
    expect(logs).not.toContain("How much did we make today");
    expect(logs).not.toContain("test-server-key");
  });
  it.each([[429,"transcription_rate_limited"],[500,"transcription_provider_failure"]] as const)(
    "retries one transient HTTP %s once and then succeeds",async(status,code)=>{
      let attempt=0;
      provider=async()=>++attempt===1?providerError(status,status===429?"rate_limit_exceeded":"server_error"):ok();
      const response=await POST(audioRequest());
      expect(response.status).toBe(200);
      expect(settings.calls).toBe(2);
      const logs=vi.mocked(console.info).mock.calls.flat().join("\n");
      expect(logs).toContain(code);
    });
  it("retries one timeout once and then succeeds",async()=>{
    let attempt=0;
    provider=async()=>{
      if(++attempt===1)throw Object.assign(new Error("hidden timeout"),{name:"AbortError"});
      return ok();
    };
    const response=await POST(audioRequest());
    expect(response.status).toBe(200);
    expect(settings.calls).toBe(2);
  });
  it("does not retry a provider 400",async()=>{
    provider=async()=>providerError(400,"invalid_request_error");
    const response=await POST(audioRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({error:"transcription_provider_failure"});
    expect(settings.calls).toBe(1);
  });
  it("retries a non-timeout network failure once, then labels it network rather than timeout",async()=>{
    provider=async()=>{throw new TypeError("SECRET network details");};
    const response=await POST(audioRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:"transcription_network"});
    expect(settings.calls).toBe(2);
    const logs=vi.mocked(console.info).mock.calls.flat().join("\n");
    expect(logs).toContain("transcription_network");
    expect(logs).not.toContain("SECRET network details");
    expect(logs).not.toContain('"timeout":true');
  });
  it("stops safely after two failed transient attempts",async()=>{
    provider=async()=>providerError(500,"server_error");
    const response=await POST(audioRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({error:"transcription_provider_failure"});
    expect(settings.calls).toBe(2);
  });
  it("rejects cross-origin uploads before sending audio to OpenAI", async () => {
    const response = await POST(audioRequest("https://other.example"));
    expect(response.status).toBe(403);
    expect(settings.calls).toBe(0);
  });
  it("denies missing owner access without provider requests", async () => {
    settings.denied = true;
    const response = await POST(audioRequest());
    expect(response.status).toBe(500);
    expect(settings.calls).toBe(0);
  });
  it("refuses a stated upload too large before parsing its body", async () => {
    const request = audioRequest();
    request.headers.set("content-length", String(9 * 1024 * 1024));
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(settings.calls).toBe(0);
  });
});
