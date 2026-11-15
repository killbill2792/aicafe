"use strict";
/**
 * TRUSTED read-only bootstrap mounted inside an isolated candidate container.
 * Candidate is given a dummy OpenAI key only. This redirects its genuine
 * Responses API call to the trusted host broker; unrelated fetches stay normal.
 * No provider credential, audit ledger, or privileged filesystem is mounted.
 */
const upstream=globalThis.fetch.bind(globalThis);
const token=process.env.AICAFE_14B_BROKER_TOKEN;
if(typeof token!=="string"||token.length<40)
 throw Error("task14b_local_proxy_token_required");
globalThis.fetch=async function task14bTrustedFetch(input,init){
 const url=typeof input==="string"?input:
  input instanceof URL?input.toString():
  input&&typeof input.url==="string"?input.url:null;
 if(!url)return upstream(input,init);
 let target;try{target=new URL(url)}catch{return upstream(input,init)}
 if(target.hostname!=="api.openai.com")return upstream(input,init);
 if(target.protocol!=="https:"||target.pathname!=="/v1/responses"||
    target.search||target.hash)
  throw Error("task14b_provider_endpoint_not_authorized");
 // Caller could forge arbitrary OpenAI headers; NEVER transmit candidate
 // bearer credentials to trusted process other than this ephemeral proxy token.
 const base=input instanceof Request?input:null;
 const method=(init?.method??base?.method??"GET").toUpperCase();
 if(method!=="POST")throw Error("task14b_provider_method_not_authorized");
 const body=init?.body??base?.body;
 if(body===undefined||body===null)
  throw Error("task14b_provider_body_required");
 const signal=init?.signal??base?.signal;
 return upstream("http://127.0.0.1:8788/v1/responses",{
  method:"POST",headers:{
   "authorization":"Bearer "+token,
   "content-type":"application/json",
  },body,signal,redirect:"error",duplex:"half"
 });
};
