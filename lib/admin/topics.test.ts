import { describe,expect,it } from "vitest";
import {classifyOwnerQuestion,homeCardCandidates,TOPIC_VERSION} from "./topics";
describe("deterministic question topics",()=>{
  it.each([
    ["What is my break-even?", "break_even"],
    ["What are my best sellers?", "best_sellers"],
    ["Change employee shift tomorrow", "schedule"],
    ["How much is payroll?", "labor"],
    ["Should I raise my menu price?", "menu_price"],
    ["Do I have enough oat milk stock?", "inventory"],
    ["Show rent expenses", "expenses"],
    ["Net sales yesterday?", "sales"],
    ["¿Cuál es el punto de equilibrio?", "break_even"],
    ["¿Qué productos son más vendidos?", "best_sellers"],
    ["كم تكلفة العمالة؟", "labor"],
    ["ما هي المنتجات الأكثر مبيعا؟", "best_sellers"],
    ["ما هي الإيرادات اليوم؟", "sales"],
    ["ما هي اَلْإِيْرَادَات اليوم؟", "sales"],
    ["ما هي أَفْضَل مَبِيعَات اليوم؟", "best_sellers"],
    ["أين نقطة التَّعادُل؟", "break_even"],
    ["Hi!", "other"],
  ])("classifies %s as %s",(text,topic)=>expect(classifyOwnerQuestion(text)).toBe(topic));
  it("does not invent topics and keeps candidate flags explicit",()=>{
    expect(TOPIC_VERSION).toBe(1);
    expect(homeCardCandidates.has("other")).toBe(false);
    expect(classifyOwnerQuestion("")).toBe("other");
  });
});
