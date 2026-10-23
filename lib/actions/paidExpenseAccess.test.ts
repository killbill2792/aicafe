import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/types",()=>({isAiConfigured:()=>true}));
vi.mock("@/lib/access/access.server",()=>({
 requireOwnerAccessScope:async()=>({businessId:"cafe",userId:"owner",access:{active:false}})
}));
vi.mock("next-intl/server",()=>({getTranslations:async()=>()=> "Free access ended"}));
vi.mock("@/lib/ai/prompts/receiptReading",()=>({readReceipt:vi.fn()}));
vi.mock("@/lib/ai/prompts/voiceExpense",()=>({parseVoiceExpense:vi.fn()}));
import {readReceipt} from "@/lib/ai/prompts/receiptReading";
import {parseVoiceExpense} from "@/lib/ai/prompts/voiceExpense";
import {reviewReceiptPhoto} from "./receiptReview";
import {reviewVoiceExpense} from "./voiceReview";
describe("paid expense actions deny expired cafés before model invocation",()=>{
 it("receipt AI is not called",async()=>{
  const result=await reviewReceiptPhoto("data:image/jpeg;base64,eA==");
  expect(result).toMatchObject({ok:false});
  expect(readReceipt).not.toHaveBeenCalled();
 });
 it("voice AI is not called",async()=>{
  const result=await reviewVoiceExpense("I paid $12 for coffee");
  expect(result).toMatchObject({ok:false});
  expect(parseVoiceExpense).not.toHaveBeenCalled();
 });
});
