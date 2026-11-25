import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** The model can ask a public question, never select a café or supply credentials. */
/** Only owner-designated public terms leave the private Supervisor context.
 * Never concatenate model-proposed terms, prior messages or tool data. */
export function ownerPublicSearchTerms(ownerText:string,city?:string|null):string|null{
 const text=ownerText.normalize("NFKC").trim();
 if(!text||text.length>250||/[\r\n<>{}\[\]@%$€£"\\]/u.test(text)||
    /\b(?:password|secret|token|payroll|invoice|bank|sales|customer|employee|private|confidential|revenue|profit|wages|receipt|account number)\b/iu.test(text))return null;
 const explicit=text.match(/^(?:please\s+)?(?:search(?: the web| online)? for|look up|check online(?: for)?|find online)\s+(.+)$/iu);
 const natural=/^(?:please\s+)?(?:what(?:'s| is| are)|where(?:'s| is| are)|when(?:'s| is| are)|how|check|find)\b/iu.test(text)&&
   /\b(?:weather|forecast|festival|parade|road closures?|public holidays?|news|opening hours|public events?)\b/iu.test(text);
 const terms=(explicit?.[1]??(natural?text:null))?.trim();
 if(!terms||! /^[\p{L}\p{N}\p{M} ,.'?()&/-]+$/u.test(terms)||/https?:|\.\./iu.test(terms))return null;
 const place=city?.trim();
 return place&&/^[\p{L}\p{M} .'-]{1,80}$/u.test(place)&&terms.length+place.length+4<=250
   ?terms+" in "+place:terms;
}
/** The provider receives only safe, owner-designated public terms. The model's arbitrary query string is never sent. */
export function projectOwnerPublicQuery(_modelQuery:string,ownerText:string,city?:string|null):string|null{
 return ownerPublicSearchTerms(ownerText,city);
}
export const webSearchInput=z.strictObject({query:z.string().trim().min(2).max(250)});

export const webSearchTools={
  web_search:{
    agentId:"alex",
    schema:webSearchInput,
    description:"Read-only search of public web pages for facts outside the café: news, weather, event or parade routes, opening hours, road closures, dates and other current information. Return a short answer and links to the source pages. Use for a question that needs outside or fresh facts, not for café sales/staff/financial data (use café tools), simple ideas or writing (answer directly). Never pass passwords, tokens, owner messages, private café details or customer data in the query.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {query}=webSearchInput.parse(raw);
      if(!ctx.webSearch)return {source:"web_search",period:null,agentId:"alex",missing:[],
        notCovered:["webSearchUnavailable"],answer:null,sources:[]};
      const found=await ctx.webSearch(query);
      if(!found.available)return {source:"web_search",period:null,agentId:"alex",missing:[],
        notCovered:[found.reason==="unsafeQuery"?"publicSearchTermsRequired":"webSearchFailed"],failure:found.reason,answer:null,sources:[]};
      return {source:"web_search",period:null,agentId:"alex",missing:[],
        answer:found.answer,sources:found.sources};
    },
  },
} as const;
