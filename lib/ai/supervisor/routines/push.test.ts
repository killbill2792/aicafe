import {createECDH,randomBytes,randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {pushAvailable,pushDeviceHash,sealPushSubscription,openPushSubscription,
  validatePushSubscription,sendPushReport} from "./push.server";
const client=createECDH("prime256v1");client.generateKeys();
const sample=()=>({
  endpoint:"https://fcm.googleapis.com/fcm/send/opaque123",
  keys:{p256dh:client.getPublicKey().toString("base64url"),
    auth:randomBytes(16).toString("base64url")},
});
describe("opt-in device push privacy",()=>{
  it("stays off without explicitly configured private credentials",()=>{
    vi.stubEnv("SUPERVISOR_U4_PUSH_ENABLED","false");
    try{expect(pushAvailable()).toBe(false);}finally{vi.unstubAllEnvs();}
  });
  it("seals and authenticates the entire subscription, never storing plain endpoint",()=>{
    vi.stubEnv("SUPERVISOR_PUSH_STORAGE_KEY",randomBytes(32).toString("base64url"));
    try{
      const value=sample(),ciphertext=sealPushSubscription(value);
      expect(ciphertext).not.toContain(value.endpoint);
      expect(openPushSubscription(ciphertext)).toEqual(value);
      expect(pushDeviceHash(value.endpoint)).toHaveLength(64);
      expect(()=>openPushSubscription(ciphertext.slice(0,-4)+"aaaa")).toThrow();
    }finally{vi.unstubAllEnvs();}
  });
  it("rejects SSRF endpoints and malformed browser keys",()=>{
    expect(()=>validatePushSubscription({...sample(),endpoint:"http://127.0.0.1:9000"})).toThrow();
    expect(()=>validatePushSubscription({...sample(),endpoint:"https://localhost"})).toThrow();
    expect(()=>validatePushSubscription({...sample(),keys:{p256dh:"wrong",auth:"wrong"}})).toThrow();
  });
});

describe("real encrypted Web Push wire receipt without network or private report",()=>{
  it("classifies success, subscription expiry and retryable provider failures",async()=>{
    const vapid=createECDH("prime256v1");vapid.generateKeys();
    vi.stubEnv("SUPERVISOR_PUSH_VAPID_PUBLIC_KEY",
      vapid.getPublicKey().toString("base64url"));
    vi.stubEnv("SUPERVISOR_PUSH_VAPID_PRIVATE_KEY",
      vapid.getPrivateKey().toString("base64url"));
    vi.stubEnv("SUPERVISOR_PUSH_VAPID_SUBJECT","mailto:owner@example.invalid");
    const send=vi.fn(async()=>new Response(null,{status:201}));
    vi.stubGlobal("fetch",send);
    try{
      const subscription=sample(),run=randomUUID();
      expect(await sendPushReport(subscription,run)).toBe("sent");
      expect(send).toHaveBeenCalledTimes(1);
      const [endpoint,request]=send.mock.calls[0] as unknown as [string,RequestInit];
      expect(endpoint).toBe(subscription.endpoint);
      expect(request.method).toBe("POST");
      const headers=request.headers as Record<string,string>;
      expect(headers["Content-Encoding"]).toBe("aes128gcm");
      expect(headers.Authorization).toMatch(/^vapid t=/u);
      expect(headers.TTL).toBe("3600");
      const bytes=request.body as Uint8Array;
      expect(bytes.byteLength).toBeGreaterThan(90);
      expect(Buffer.from(bytes).toString("utf8")).not.toContain("report");
      expect(Buffer.from(bytes).toString("utf8")).not.toContain(run);
      send.mockResolvedValueOnce(new Response(null,{status:410}));
      expect(await sendPushReport(subscription,run)).toBe("gone");
      send.mockResolvedValueOnce(new Response(null,{status:503}));
      expect(await sendPushReport(subscription,run)).toBe("retry");
    }finally{
      vi.unstubAllGlobals();vi.unstubAllEnvs();
    }
  });
});
