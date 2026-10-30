import {describe,it,expect} from "vitest";
import {validateOwnerAnswers} from "./answers";
import {catalogForMissing} from "./catalog";

const fields=[{key:"event_outcome:halloween:2025",inputType:"choice",units:[],defaultUnit:"",
  choices:[{label:"Busier",value:"busier"},{label:"About the same",value:"normal"},
    {label:"Quieter",value:"quieter"},{label:"Closed",value:"closed"}]}] as const;
describe("event outcome owner answer",()=>{
  it("uses the existing owner-fact catalog for a dated event answer",()=>{
    expect(catalogForMissing("event_outcome:halloween:2025")).toEqual({
      factKey:"event_outcome:halloween:2025",type:"text",labelKey:"generic",target:"owner_facts"});
  });
  it("saves a selected value under the dated event fact",()=>{
    expect(validateOwnerAnswers(fields,[{fieldKey:fields[0].key,value:"quieter"}],"en"))
      .toEqual([{fieldKey:"event_outcome:halloween:2025",value:"quieter",unit:null,periodScope:null}]);
  });
  it("saves optional owner-typed Other text, including non-English text",()=>{
    expect(validateOwnerAnswers(fields,[{fieldKey:fields[0].key,value:"other:كان المقهى مزدحمًا"}],"ar"))
      .toEqual([{fieldKey:"event_outcome:halloween:2025",value:"other:كان المقهى مزدحمًا",unit:null,periodScope:null}]);
    expect(validateOwnerAnswers(fields,[{fieldKey:fields[0].key,value:"other"}],"en")[0].value).toBe("other");
  });
  it("rejects an invented option that was not selected as Other",()=>{
    expect(()=>validateOwnerAnswers(fields,[{fieldKey:fields[0].key,value:"invented"}],"en"))
      .toThrow("invalid_owner_choice");
    expect(()=>validateOwnerAnswers(fields,[{fieldKey:fields[0].key,value:"other:"+"x".repeat(201)}],"en"))
      .toThrow("invalid_owner_choice");
  });
});
