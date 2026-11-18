import {describe,it,expect,vi} from "vitest";
import {permissionTools} from "./permissions";

const goal={
  id:"m",revision:2,capability_id:"leo.goal.v1",capability_version:1,
  limit_kind:"count",limit_value:5,period_kind:"cafe_day",staff_week_start:null,
  expires_at:"2099-01-01T00:00:00.000Z",revoked_at:null,superseded_at:null,
};
const context=(readPermissions?:()=>Promise<unknown>)=>({
  readPermissions,asOf:"2026-11-17T00:00:00.000Z",
}) as never;
describe("Supervisor permission self-inspection",()=>{
  it("reads canonical scoped rows without revealing factor, owner or policy hashes",async()=>{
    const read=vi.fn(async()=>[{...goal,
      business_id:"never-expose",owner_user_id:"never-expose",policy_hash:"never-expose",
      factor_id:"never-expose"}]);
    const result=await permissionTools.get_supervisor_permissions.execute({},context(read));
    expect(read).toHaveBeenCalledOnce();
    expect(result).toMatchObject({source:"supervisor_mandates",missing:[],
      permissions:[{capabilityId:"leo.goal.v1",status:"active",limitValue:5}]});
    expect(JSON.stringify(result)).not.toContain("never-expose");
  });
  it("does not turn old or revoked mandates into active authority",async()=>{
    const result=await permissionTools.get_supervisor_permissions.execute({},
      context(async()=>[
        {...goal,expires_at:"2000-01-01T00:00:00.000Z"},
        {...goal,revoked_at:"2026-11-16T00:00:00.000Z"},
        {...goal,superseded_at:"2026-11-16T00:00:00.000Z"},
      ]));
    expect((result.permissions as Array<{status:string}>).map(x=>x.status))
      .toEqual(["expired","revoked","superseded"]);
  });
  it("fails closed without the verified owner port",async()=>{
    const result=await permissionTools.get_supervisor_permissions.execute({},context());
    expect(result).toMatchObject({missing:["owner_permission_reader_unavailable"],permissions:[]});
    await expect(permissionTools.get_supervisor_permissions.execute(
      {ownerId:"attacker"},context(async()=>[]))).rejects.toThrow();
  });
  it("never guesses from a failed database read",async()=>{
    await expect(permissionTools.get_supervisor_permissions.execute({},
      context(async()=>{throw new Error("database unavailable");}))).rejects.toThrow("database unavailable");
  });
});
