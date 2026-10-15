import { describe,expect,it } from "vitest";
import { reconcileDeletedDraftIds } from "./reconcileDraft";
describe("Olivia co-owner conflict draft reconciliation",()=>{
  it("preserves live record IDs for optimistic revision updates",()=>{
    const draft=[{id:"live",start_local:"09:00"}];
    expect(reconcileDeletedDraftIds(draft,[{id:"live"}])).toEqual(draft);
  });
  it("removes deleted IDs but preserves unsaved draft content as a new create",()=>{
    const draft=[{id:"removed",start_local:"10:00",overnight:false},
      {id:"live",start_local:"14:00",overnight:false}];
    expect(reconcileDeletedDraftIds(draft,[{id:"live"}])).toEqual([
      {start_local:"10:00",overnight:false},
      {id:"live",start_local:"14:00",overnight:false},
    ]);
    expect(draft[0].id).toBe("removed");
  });
  it("retains new unsaved windows on refresh",()=>{
    const draft: Array<{id?:string;start_local:string}>=[{start_local:"07:00"}];
    expect(reconcileDeletedDraftIds(draft,[]))
      .toEqual([{start_local:"07:00"}]);
  });
});
