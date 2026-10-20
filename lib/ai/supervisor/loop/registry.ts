import {z} from "zod";
/** All effectful entry points are server-registered. Model input cannot supply handlers.
 * Type discriminants prevent a read/simulate/evaluate handler from receiving a mutation facade.
 */
export const loopModes=["read","simulate","propose","approve","commit","evaluate"] as const;
export type LoopMode=typeof loopModes[number];
export const effectResultStatus=z.enum(["verified","estimated","partial","unavailable",
  "insufficient_evidence","requires_approval","conflict","failed","requires_manual_action"]);
export type EffectResultStatus=z.infer<typeof effectResultStatus>;
type Common<I,O>={id:string;version:1;owner:string;description:string;
  inputSchema:z.ZodType<I>;outputSchema:z.ZodType<O>};
export type ReadOnlyCapability<I,O>=Common<I,O>&{
  mode:"read"|"simulate"|"evaluate";read:(input:I)=>Promise<O>;
  propose?:never;approve?:never;commit?:never;
};
export type ProposeCapability<I,O>=Common<I,O>&{
  mode:"propose";propose:(input:I,store:ProposalWriter)=>Promise<O>;
  read?:never;approve?:never;commit?:never;
};
export type ApprovalCapability<I,O>=Common<I,O>&{
  mode:"approve";approve:(input:I,store:ApprovalWriter)=>Promise<O>;
  read?:never;propose?:never;commit?:never;
};
export type CommitCapability<I,O>=Common<I,O>&{
  mode:"commit";commit:(input:I,store:CommitWriter)=>Promise<O>;
  read?:never;propose?:never;approve?:never;
};
export type ProposalWriter={draft(payload:unknown):Promise<unknown>};
export type ApprovalWriter={approve(reference:unknown):Promise<unknown>};
export type CommitWriter={commit(reference:unknown):Promise<unknown>};
export type LoopCapability=ReadOnlyCapability<never,unknown>|ProposeCapability<never,unknown>|
  ApprovalCapability<never,unknown>|CommitCapability<never,unknown>;
/** Type-preserving factory: adding a new specialist only adds its own descriptors. */
export function loopRead<I,O>(entry:ReadOnlyCapability<I,O>):ReadOnlyCapability<I,O>{return entry;}
export function loopPropose<I,O>(entry:ProposeCapability<I,O>):ProposeCapability<I,O>{return entry;}
export function loopApprove<I,O>(entry:ApprovalCapability<I,O>):ApprovalCapability<I,O>{return entry;}
export function loopCommit<I,O>(entry:CommitCapability<I,O>):CommitCapability<I,O>{return entry;}
/** Erased runtime view. Domain input/output types remain validated by typed factories. */
export type Registration={
 id:string;version:1;owner:string;description:string;mode:LoopMode;
 inputSchema:z.ZodType;outputSchema:z.ZodType;
 read?:(input:never)=>Promise<unknown>;
 propose?:(input:never,store:ProposalWriter)=>Promise<unknown>;
 approve?:(input:never,store:ApprovalWriter)=>Promise<unknown>;
 commit?:(input:never,store:CommitWriter)=>Promise<unknown>;
};
export function createLoopRegistry(registrations:readonly Registration[]){
  const table=new Map<string,Registration>();
  for(const entry of registrations){
    if(!entry.id||entry.version!==1||!loopModes.includes(entry.mode)||table.has(entry.id))
      throw new Error("invalid_duplicate_capability");
    const expected=["read","simulate","evaluate"].includes(entry.mode)?"read":entry.mode;
    for(const key of ["read","propose","approve","commit"] as const){
      const candidate=(entry as unknown as Record<string,unknown>)[key];
      if((key===expected)!==(typeof candidate==="function"))
        throw new Error("mode_handler_boundary");
    }
    table.set(entry.id,entry);
  }
  return {
    discover:()=>[...table.values()].map(({id,version,owner,mode,description})=>
      ({id,version,owner,mode,description})),
    async dispatch(id:string,input:unknown,facade?:ProposalWriter|ApprovalWriter|CommitWriter):Promise<unknown>{
      const registered=table.get(id);
      if(!registered)throw new Error("unknown_capability");
      const parsed=registered.inputSchema.parse(input);
      let result:unknown;
      switch(registered.mode){
        case "read":case "simulate":case "evaluate":
          result=await registered.read(parsed);break;
        case "propose":
          if(!facade||!("draft" in facade))throw new Error("proposal_authorization_required");
          result=await registered.propose(parsed,facade);break;
        case "approve":
          if(!facade||!("approve" in facade))throw new Error("approval_authorization_required");
          result=await registered.approve(parsed,facade);break;
        case "commit":
          if(!facade||!("commit" in facade))throw new Error("commit_authorization_required");
          result=await registered.commit(parsed,facade);break;
      }
      return registered.outputSchema.parse(result);
    },
  };
}
