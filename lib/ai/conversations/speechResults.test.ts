import {describe,expect,it} from "vitest";
import {appendSpeech,speechChunks} from "./speechResults";
describe("Supervisor speech recognition preview and confirmed transcript",()=>{
  it("keeps interim and final segments distinct so no partial transcript is submitted",()=>{
    expect(speechChunks([
      Object.assign([{transcript:"two coffees"}],{isFinal:true}),
      Object.assign([{transcript:"and one muffin"}],{isFinal:false}),
    ])).toEqual({final:"two coffees",interim:"and one muffin"});
  });
  it("preserves typed text and truncates at the composer input limit",()=>{
    expect(appendSpeech("What about", "expenses")).toBe("What about expenses");
    expect(appendSpeech("a".repeat(4000),"more")).toHaveLength(4000);
  });
  it("handles empty and legacy speech results",()=>{
    expect(speechChunks([])).toEqual({final:"",interim:""});
    expect(speechChunks([[{transcript:"hello"}]])).toEqual({final:"hello",interim:""});
  });
});
