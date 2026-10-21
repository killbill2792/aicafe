import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import SupervisorOwnerQuestionCard from "./SupervisorOwnerQuestionCard";
import type {OwnerQuestion} from "@/lib/ai/supervisor/ownerInput/contracts";
const uuid="11111111-1111-4111-8111-111111111111";
const copy={dismiss:"Not now",confirm:"Continue",other:"Answer another way",answer:"Your answer"};
const title={en:"Which latte?",es:"¿Cuál café?",ar:"أي قهوة؟"};
const options=(count:number):OwnerQuestion=>({
  type:"owner_question",questionId:uuid,title,
  input:{kind:"options",options:Array.from({length:count},(_,i)=>({
    id:"option-"+i,label:{en:"Latte "+i,es:"Café "+i,ar:"قهوة "+i},
  }))},
});
const render=(card:OwnerQuestion,locale:"en"|"es"|"ar"="en")=>
  renderToStaticMarkup(createElement(SupervisorOwnerQuestionCard,
    {card,locale,copy,onAnswer:vi.fn(),onDismiss:vi.fn()}));
describe("adaptive owner question card",()=>{
  it("renders two available choices as full touch target rows",()=>{
    const html=render(options(2));
    expect(html).toContain("Latte 0");
    expect(html).toContain("Latte 1");
    expect(html).toContain("min-h-12 w-full");
    expect(html).not.toContain("max-h-72");
  });
  it("makes 8 choices scrollable without truncation",()=>{
    const html=render(options(8));
    expect(html).toContain("max-h-72 overflow-y-auto");
    expect(html).toContain("Latte 7");
    for(let i=0;i<8;i++)expect(html).toContain("option-"+i);
  });
  it("renders an owner-answerable new fact as a typed entry and confirm action",()=>{
    const card:OwnerQuestion={type:"owner_question",questionId:uuid,
      title:{en:"What did oat milk cost?",es:"¿Qué costó?",ar:"ما التكلفة؟"},
      input:{kind:"free_text",hint:{en:"4.50 / 946",es:"4.50 / 946",ar:"4.50 / 946"}}};
    const html=render(card);
    expect(html).toContain("<input");
    expect(html).toContain('placeholder="4.50 / 946"');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain("Latte 0");
  });
  it("keeps the dismiss control rendered while submitting and after a failed response",()=>{
    const card=options(2);
    const pending=renderToStaticMarkup(createElement(SupervisorOwnerQuestionCard,
      {card,locale:"en" as const,copy,disabled:true,onAnswer:vi.fn(),onDismiss:vi.fn()}));
    const retryable=render(card);
    expect(pending).toContain("Which latte?");
    expect(pending).toContain('aria-label="Not now"');
    expect(pending).toContain('disabled=""');
    expect(retryable).toContain("Which latte?");
    expect(retryable).toContain('aria-label="Not now"');
    expect(retryable).not.toContain('disabled=""');
  });
  it("provides an accessible localized dismiss control and Arabic RTL",()=>{
    const html=render(options(2),"ar");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('aria-label="Not now"');
    expect(html).toContain("أي قهوة؟");
    expect(html).toContain("focus-visible:outline");
  });
});
