import "server-only";
import {createHash,randomBytes} from "node:crypto";
export const GOOGLE_MODIFY_SCOPE="https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_OAUTH_SCOPES=["openid","email",GOOGLE_MODIFY_SCOPE] as const;
const AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL="https://oauth2.googleapis.com/token";
export function oauthConfig(){
  const clientId=process.env.GOOGLE_GMAIL_CLIENT_ID;
  const clientSecret=process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  const redirectUri=process.env.GOOGLE_GMAIL_REDIRECT_URI;
  if(!clientId||!clientSecret||!redirectUri)throw new Error("gmail_not_configured");
  const redirect=new URL(redirectUri);
  if(redirect.pathname!=="/api/connectors/gmail/callback"||
    (redirect.protocol!=="https:"&&!(redirect.protocol==="http:"&&redirect.hostname==="localhost")))
    throw new Error("gmail_redirect_uri_invalid");
  return {clientId,clientSecret,redirectUri};
}
export function newOAuthChallenge(){
  const state=randomBytes(32).toString("base64url");
  const verifier=randomBytes(32).toString("base64url");
  const challenge=createHash("sha256").update(verifier).digest("base64url");
  return {state,verifier,challenge};
}
export function authorizationUrl(state:string,challenge:string):string{
  const {clientId,redirectUri}=oauthConfig();
  const u=new URL(AUTH_URL);
  u.searchParams.set("client_id",clientId);
  u.searchParams.set("redirect_uri",redirectUri);
  u.searchParams.set("response_type","code");
  u.searchParams.set("access_type","offline");
  u.searchParams.set("prompt","consent");
  u.searchParams.set("scope",GMAIL_OAUTH_SCOPES.join(" "));
  u.searchParams.set("state",state);
  u.searchParams.set("code_challenge_method","S256");
  u.searchParams.set("code_challenge",challenge);
  return u.toString();
}
export type GoogleTokens={access_token:string;refresh_token?:string;expires_in:number;scope?:string;token_type:string};
export async function tokenRequest(fields:Record<string,string>):Promise<GoogleTokens>{
  const {clientId,clientSecret}=oauthConfig();
  const response=await fetch(TOKEN_URL,{method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({...fields,client_id:clientId,client_secret:clientSecret}),
    cache:"no-store",signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error("gmail_token_exchange_failed");
  const json=await response.json() as Partial<GoogleTokens>;
  if(!json.access_token||!Number.isFinite(json.expires_in)||!json.token_type||json.token_type.toLowerCase()!=="bearer")
    throw new Error("gmail_invalid_token_response");
  return json as GoogleTokens;
}
export async function exchangeCode(code:string,verifier:string):Promise<GoogleTokens>{
  return tokenRequest({code,code_verifier:verifier,redirect_uri:oauthConfig().redirectUri,grant_type:"authorization_code"});
}
export async function verifiedGoogleMailbox(accessToken:string):Promise<{subject:string;email:string}>{
  const headers={authorization:"Bearer "+accessToken};
  const [identity,mailbox]=await Promise.all([
    fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers,cache:"no-store",signal:AbortSignal.timeout(12000)}),
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile",{headers,cache:"no-store",signal:AbortSignal.timeout(12000)}),
  ]);
  if(!identity.ok||!mailbox.ok)throw new Error("gmail_identity_verification_failed");
  const user=await identity.json() as {sub?:string;email?:string;email_verified?:boolean};
  const profile=await mailbox.json() as {emailAddress?:string};
  if(!user.sub||!user.email||user.email_verified!==true||!profile.emailAddress||
    user.email.toLowerCase()!==profile.emailAddress.toLowerCase())
    throw new Error("gmail_identity_mismatch");
  return {subject:user.sub,email:profile.emailAddress};
}
