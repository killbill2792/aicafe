import {describe,it,expect} from "vitest";
import {ownerResolutionRequest,prepareOwnerResolution,resumeOwnerResolution} from "./resolution";
const options=[{id:"a0000000-0000-4000-8000-000000000001",
  label:{en:"Latte 12 oz — $5.00",es:"Latte 12 oz — $5.00",ar:"لاتيه 12"}},
  {id:"a0000000-0000-4000-8000-000000000002",
    label:{en:"Latte 16 oz — $7.00",es:"Latte 16 oz — $7.00",ar:"لاتيه 16"}}];
const question={en:"Which latte?",es:"¿Qué latte?",ar:"أي لاتيه؟"};
describe("one typed, non-writing owner resolution contract",()=>{
  const request=ownerResolutionRequest({question,input:{kind:"options",options},
    context:{domain:"menu",catalogRevision:"123"}});
  it("accepts only one of the server-issued canonical catalog IDs",()=>{
    expect(prepareOwnerResolution(request,options[1].id)).toMatchObject({answer:options[1].id});
    for(const invalid of ["",options[0].label.en,"00000000-0000-4000-8000-000000000003"])
      expect(prepareOwnerResolution(request,invalid)).toBeNull();
  });
  it("retains the authenticated selection as context, not as a fabricated business fact",()=>{
    const resumed=resumeOwnerResolution("How much does the latte cost?",request,options[0].id);
    expect(resumed).toContain("selected catalog productId="+options[0].id);
    expect(resumed).toContain("How much does the latte cost?");
  });
  it("never accepts resolution without the dedicated resolution mode and capability",()=>{
    expect(prepareOwnerResolution({...request,mode:"write"},options[0].id)).toBeNull();
    expect(prepareOwnerResolution({...request,writeCapabilityId:"menu.ingredient_price.manual.v1"},options[0].id)).toBeNull();
    expect(prepareOwnerResolution({...request,fieldId:"other"},options[0].id)).toBeNull();
  });
  it("rejects blank free text and overlong responses",()=>{
    const free=ownerResolutionRequest({question,
      input:{kind:"free_text",hint:question}});
    expect(prepareOwnerResolution(free,"    ")).toBeNull();
    expect(prepareOwnerResolution(free,"z".repeat(201))).toBeNull();
    expect(prepareOwnerResolution(free,"I meant next week")).toMatchObject({answer:"I meant next week"});
  });
});
