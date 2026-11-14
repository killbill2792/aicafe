import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {newOAuthChallenge,authorizationUrl,exchangeCode,verifiedGoogleMailbox,GOOGLE_MODIFY_SCOPE} from "./oauth.server";
beforeEach(()=>{
 vi.stubEnv("GOOGLE_GMAIL_CLIENT_ID","fake-client-id.apps.googleusercontent.com");
 vi.stubEnv("GOOGLE_GMAIL_CLIENT_SECRET","fake-server-secret");
 vi.stubEnv("GOOGLE_GMAIL_REDIRECT_URI","http://localhost:3000/api/connectors/gmail/callback");
 vi.unstubAllGlobals();
});
describe("Gmail one-click PKCE OAuth",()=>{
 it("builds separate unpredictable state and PKCE challenges with offline approval",()=>{
   const x=newOAuthChallenge(),y=newOAuthChallenge();
   expect(x.state).not.toEqual(y.state);
   expect(x.verifier).not.toEqual(y.verifier);
   expect(x.challenge).not.toEqual(x.verifier);
   const u=new URL(authorizationUrl(x.state,x.challenge));
   expect(u.host).toBe("accounts.google.com");
   expect(u.searchParams.get("access_type")).toBe("offline");
   expect(u.searchParams.get("prompt")).toBe("consent");
   expect(u.searchParams.get("state")).toBe(x.state);
   expect(u.searchParams.get("code_challenge_method")).toBe("S256");
   expect(u.searchParams.get("scope")).toContain(GOOGLE_MODIFY_SCOPE);
   expect(u.toString()).not.toContain("fake-server-secret");
 });
 it("exchanges the code on the server, not in the app or agent",async()=>{
   const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({
     access_token:"fake-access",refresh_token:"fake-refresh",expires_in:3600,token_type:"Bearer",
     scope:"openid email "+GOOGLE_MODIFY_SCOPE})});
   vi.stubGlobal("fetch",fetch);
   const exchanged=await exchangeCode("owner-code","pkce-verifier");
   expect(exchanged.refresh_token).toBe("fake-refresh");
   const request=fetch.mock.calls[0][1];
   const form=request.body as URLSearchParams;
   expect(form.get("code_verifier")).toBe("pkce-verifier");
   expect(form.get("client_secret")).toBe("fake-server-secret");
   expect(form.get("grant_type")).toBe("authorization_code");
 });
 it("rejects an OAuth provider failure without reflecting its token-bearing body",async()=>{
   vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false,json:async()=>({error:"fake-secret"})}));
   await expect(exchangeCode("code","verifier")).rejects.toThrow("gmail_token_exchange_failed");
 });
 it("verifies the Google account and Gmail mailbox are the same person",async()=>{
   const fetch=vi.fn()
     .mockResolvedValueOnce({ok:true,json:async()=>({sub:"google-account",email:"owner@example.com",email_verified:true})})
     .mockResolvedValueOnce({ok:true,json:async()=>({emailAddress:"other@example.com"})});
   vi.stubGlobal("fetch",fetch);
   await expect(verifiedGoogleMailbox("fake-token")).rejects.toThrow("gmail_identity_mismatch");
   expect(fetch.mock.calls.every(([url])=>String(url).startsWith("https://"))).toBe(true);
 });
});
