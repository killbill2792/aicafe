import {describe,expect,it} from "vitest";
import {prepareScheduleCopy} from "./scheduleMessages";

describe("manual schedule copy is never a send",()=>{
  it("only prepares employees with dated shifts, ordered deterministically",()=>{
    const people=[
      {id:"amy",name:"Amy",phone:"+14155550123"},
      {id:"bob",name:"Bob",phone:null},
    ];
    const rows=[
      {employeeId:"amy",date:"2026-10-29",start:"14:00",end:"18:00"},
      {employeeId:"amy",date:"2026-10-27",start:"06:00",end:"12:00"},
    ];
    expect(prepareScheduleCopy(people,rows)).toEqual([{
      name:"Amy",phone:"+14155550123",
      text:"Amy — 2026-10-27 06:00–12:00; 2026-10-29 14:00–18:00"
    }]);
  });
  it("cannot mutate source arrays or mark a shift sent",()=>{
    const people=Object.freeze([{id:"a",name:"A",phone:null}]);
    const shifts=Object.freeze([{employeeId:"a",date:"2026-10-26",start:"07:00",end:"11:00"}]);
    const output=prepareScheduleCopy(people,shifts);
    expect(output).toHaveLength(1);
    expect(Object.keys(output[0]).sort()).toEqual(["name","phone","text"]);
    expect(output[0]).not.toHaveProperty("sent");
  });
});
