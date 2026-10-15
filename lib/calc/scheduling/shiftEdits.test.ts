import {describe,expect,it} from "vitest";
import type {PlannerShift} from "./plannerTypes";
import {addOliviaShift,moveOliviaBoundary,setOliviaUnpaidBreak,
  oliviaLocalBoundaryValue,setOliviaLocalBoundary} from "./shiftEdits";

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
  it("creates a new shift at nine in the café timezone, not UTC",()=>{
    const added=addOliviaShift("2026-10-12",[],"worker-1","cafe-1",
      "America/Los_Angeles");
    expect(added.startAt).toBe("2026-10-12T16:00:00.000Z");
    expect(oliviaLocalBoundaryValue(added.startAt,"America/Los_Angeles"))
      .toBe("2026-10-12T09:00");
  });
  it("allows precise local date/time edits and rejects ambiguous DST times",()=>{
    const updated=setOliviaLocalBoundary(base,"startAt",
      "2026-10-12T08:00","America/Los_Angeles");
    expect(updated.startAt).toBe("2026-10-12T15:00:00.000Z");
    expect(()=>setOliviaLocalBoundary(base,"startAt",
      "2026-03-08T02:30","America/Los_Angeles")).toThrow("nonexistent_local_time");
    expect(()=>setOliviaLocalBoundary(base,"startAt",
      "2026-11-01T01:30","America/Los_Angeles")).toThrow("ambiguous_local_time");
  });
  it("adds a separate future shift without silently copying prior breaks",()=>{
    const result=addOliviaShift("2026-10-12",[base],"worker-2","cafe-1");
    expect(result).toMatchObject({employeeId:"worker-2",pinned:false,
      startAt:"2026-10-13T09:00:00.000Z",endAt:"2026-10-13T13:00:00.000Z",
      paidMinutes:240,breaks:[]});
  });
});
