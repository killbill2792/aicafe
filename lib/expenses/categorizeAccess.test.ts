import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/types",()=>({isAiConfigured:()=>true}));
vi.mock("@/lib/ai/prompts/statementCategorizing",()=>({categorizeStatementLines:vi.fn()}));
import {categorizeStatementLines} from "@/lib/ai/prompts/statementCategorizing";
import {categorizeLines} from "./categorize";
const supabase={from:()=>({select:()=>({eq:async()=>({data:[],error:null})})})};
describe("expired café still categorizes statement with free rules",()=>{
 it("does not send unmatched financial text to AI when disabled",async()=>{
  const rows=await categorizeLines(supabase as never,"cafe-id",[
    {i:1,date:"2026-10-23",description:"XZQ obscure private transfer record",amount:-1},
  ],false);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe("uncategorized");
  expect(categorizeStatementLines).not.toHaveBeenCalled();
 });
});
