import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";

/** The model can ask a public question, never select a café or supply credentials. */
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
        notCovered:["webSearchFailed"],failure:found.reason,answer:null,sources:[]};
      return {source:"web_search",period:null,agentId:"alex",missing:[],
        answer:found.answer,sources:found.sources};
    },
  },
} as const;
