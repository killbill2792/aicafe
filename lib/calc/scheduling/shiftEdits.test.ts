import {describe,expect,it} from "vitest";
import type {PlannerShift} from "./plannerTypes";
import {addOliviaShift,moveOliviaBoundary,setOliviaUnpaidBreak} from "./shiftEdits";

const base:PlannerShift={employeeId:"worker-1",locationId:"cafe-1",
  startAt:"2026-10-12T09:00:00.000Z",endAt:"2026-10-12T13:00:00.000Z",
  paidMinutes:240,breaks:[],pinned:false};
describe("Olivia pure editing helpers",()=>{
  it("moves UTC instants by a 30-minute grid without mutating a saved shift",()=>{
    const changed=moveOliviaBoundary(base,"endAt",-1);
    expect(changed.endAt).toBe("2026-10-12T12:30:00.000Z");
    expect(changed.paidMinutes).toBe(210);
    expect(base.paidMinutes).toBe(240);
    expect(moveOliviaBoundary(base,"startAt",1).paidMinutes).toBe(210);
  });
  it("records unpaid break with an exact 30-minute deduction",()=>{
    const changed=setOliviaUnpaidBreak(base,true);
    expect(changed.breaks).toEqual([{
      startAt:"2026-10-12T10:00:00.000Z",
      endAt:"2026-10-12T10:30:00.000Z",paid:false,
    }]);
    expect(changed.paidMinutes).toBe(210);
    expect(setOliviaUnpaidBreak(changed,false)).toEqual(base);
  });
  it("refuses to replace verified paid or complex breaks via the simple editor",()=>{
    expect(()=>setOliviaUnpaidBreak({...base,breaks:[
      {startAt:"2026-10-12T10:00:00.000Z",
        endAt:"2026-10-12T10:30:00.000Z",paid:true},
    ]},false)).toThrow("complex_break_requires_review");
  });
  it("adds a separate future shift without silently copying prior breaks",()=>{
    const result=addOliviaShift("2026-10-12",[base],"worker-2","cafe-1");
    expect(result).toMatchObject({employeeId:"worker-2",pinned:false,
      startAt:"2026-10-13T09:00:00.000Z",endAt:"2026-10-13T13:00:00.000Z",
      paidMinutes:240,breaks:[]});
  });
});
