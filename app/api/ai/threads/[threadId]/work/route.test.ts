import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  authenticatedConversationContext: auth,
  ConversationApiError: class ConversationApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: client }));

const cancel=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/ai/supervisor/runs/repository.server",()=>({cancelOwnerRun:cancel}));
import { GET, POST } from "./route";

const thread = "123e4567-e89b-42d3-a456-426614174000";
function database() {
  const filters: Record<string, Array<[string, string, unknown]>> = {};
  const source: Record<string, unknown[]> = {
    supervisor_runs: [], supervisor_run_steps: [], ai_agent_jobs: [],
    supervisor_proposals: [], supervisor_effect_attempts: [], supervisor_investigations: [], ai_threads: [],
  };
  const db = { from(table: string) {
    const predicates: Array<(row: Record<string,unknown>) => boolean> = [];
    let sort: {field: string; ascending: boolean} | null = null;
    let limit = Infinity;
    const rows = (from=0,to=Infinity) => {
      let result = (source[table] ?? []).map(x => x as Record<string,unknown>).filter(row =>
        predicates.every(predicate => predicate(row)));
      if (sort) {
        const {field,ascending} = sort;
        result = result.sort((a,b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")) *
          (ascending ? 1 : -1));
      }
      return { data: result.slice(from,Math.min(to+1,limit)), error: null };
    };
    const query = {
      select() { return query; },
      eq(field: string, value: unknown) {
        (filters[table] ??= []).push(["eq",field,value]);
        predicates.push(row => !(field in row) || row[field] === value);
        return query;
      },
      is(field:string,value:null){predicates.push(row=>row[field]==null&&value===null);return query;},
      neq(field: string, value: unknown) {
        predicates.push(row => row[field] !== value); return query;
      },
      in(field: string, values: unknown[]) {
        (filters[table] ??= []).push(["in",field,values]);
        predicates.push(row => !(field in row) || values.includes(row[field]));
        return query;
      },
      not(field: string, operator: string, value: string | null) {
        if (operator === "in" && value) {
          const statuses = value.slice(1,-1).split(",");
          predicates.push(row => !statuses.includes(String(row[field])));
        } else if (operator === "is") {
          predicates.push(row => row[field] !== value);
        } else throw new Error("Unexpected filter");
        return query;
      },
      or(expression: string) {
        if (expression === "status.neq.completed,final_report_ref.is.null")
          predicates.push(row => row.status !== "completed" || row.final_report_ref == null);
        else if (expression === "status.neq.done,reply_message_id.is.null")
          predicates.push(row => row.status !== "done" || row.reply_message_id == null);
        else throw new Error("Unexpected OR filter: " + expression);
        return query;
      },
      order(field: string, options: {ascending?: boolean} = {}) {
        sort = {field,ascending:options.ascending ?? true}; return query;
      },
      limit(n: number) { limit = n; return query; },
      range(from: number,to: number) { return Promise.resolve(rows(from,to)); },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve(resolve(rows())); },
    };
    return query;
  } };
  return { db, filters, source };
}
beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ scope: { businessId: "cafe-a", ownerUserId: "owner-a" },
    service: { getThread: vi.fn().mockResolvedValue({ id: thread }) } });
});
describe("GET /work owner isolation and receipt verification", () => {
  it("uses business, owner and thread scope on every top-level ledger", async () => {
    const { db, filters } = database();
    client.mockResolvedValue(db);
    const response = await GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.work).toEqual([]);
    for (const table of ["supervisor_runs", "supervisor_proposals", "supervisor_investigations"]) {
      expect(filters[table]).toEqual(expect.arrayContaining([
        ["eq", "business_id", "cafe-a"], ["eq", "owner_user_id", "owner-a"],
        ["eq", "thread_id", thread],
      ]));
    }
    expect(filters.ai_agent_jobs).toEqual(expect.arrayContaining([
      ["eq", "business_id", "cafe-a"], ["eq", "owner_user_id", "owner-a"],
      ["eq", "thread_id", thread],
    ]));
    expect(filters.supervisor_run_steps).toBeUndefined();
    expect(filters.supervisor_effect_attempts).toBeUndefined();
  });
  it("returns work from other owned threads but no other owner or café in owner-wide mode", async () => {
    const {db,source,filters}=database();
    const scope={business_id:"cafe-a",owner_user_id:"owner-a"};
    source.ai_threads=[{...scope,id:thread,title:"First"}, {...scope,id:"other-thread",title:"Second"},
      {...scope,owner_user_id:"someone-else",id:"private",title:"Private"}];
    source.supervisor_proposals=[
      {...scope,thread_id:thread,id:"first",status:"draft",effect_hash:"hash",updated_at:"2026-11-14"},
      {...scope,thread_id:"other-thread",id:"second",status:"draft",effect_hash:"hash",updated_at:"2026-11-14"},
      {...scope,thread_id:"private",owner_user_id:"someone-else",id:"private",status:"draft",effect_hash:"hash"},
      {...scope,thread_id:"foreign",business_id:"cafe-b",id:"foreign",status:"draft",effect_hash:"hash"},
    ];
    client.mockResolvedValue(db);
    const response=await GET(new Request("https://example.org?scope=owner"),{params:Promise.resolve({threadId:thread})});
    expect(response.status).toBe(200);
    const work=(await response.json()).work;
    expect(work).toHaveLength(2);
    expect(work).toEqual(expect.arrayContaining([
      expect.objectContaining({id:"proposal:first",threadId:thread,threadTitle:"First",status:"approval_required"}),
      expect.objectContaining({id:"proposal:second",threadId:"other-thread",threadTitle:"Second",status:"approval_required"}),
    ]));
    for(const table of ["supervisor_runs","ai_agent_jobs","supervisor_proposals","supervisor_investigations","ai_threads"])
      expect(filters[table]).toEqual(expect.arrayContaining([["eq","business_id","cafe-a"],["eq","owner_user_id","owner-a"]]));
  });
  it("scopes nested steps/effects by business and IDs read from the authorized conversation", async () => {
    const { db, filters, source } = database();
    source.supervisor_runs = [{ id: "run-a", request_key: "owner-message", status: "running", final_report_ref: null,
      updated_at: "2026-11-14T10:00:00Z", finished_at: null }];
    source.supervisor_proposals = [{ id: "proposal-a", capability_id: "purchase", status: "draft",
      effect_hash: "hash-a", updated_at: "2026-11-14T10:00:00Z" }];
    client.mockResolvedValue(db);
    const response = await GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    expect(response.status).toBe(200);
    expect(filters.supervisor_run_steps).toEqual(expect.arrayContaining([
      ["eq", "business_id", "cafe-a"], ["in", "run_id", ["run-a"]],
    ]));
    expect(filters.supervisor_effect_attempts).toEqual(expect.arrayContaining([
      ["eq", "business_id", "cafe-a"], ["in", "proposal_id", ["proposal-a"]],
    ]));
  });
  it("retains old unresolved approvals, runs, jobs and 15A investigations after 30 newer finished items", async () => {
    const {db,source} = database();
    const date = (n:number) => new Date(Date.parse("2026-11-01T00:00:00Z") + n*60_000).toISOString();
    const own = { business_id:"cafe-a",owner_user_id:"owner-a",thread_id:thread };
    source.supervisor_runs = [
      {...own,id:"old-run",request_key:"old-request",status:"blocked",final_report_ref:null,updated_at:date(0),finished_at:null},
      ...Array.from({length:30},(_,i) => ({...own,id:"completed-"+i,request_key:"message-"+i,
        status:"completed",final_report_ref:"saved-"+i,updated_at:date(i+1),finished_at:date(i+1)})),
    ];
    source.ai_agent_jobs = [
      {...own,id:"old-job",owner_message_id:"different",status:"running",reply_message_id:null,
        heartbeat_at:date(0),created_at:date(0),attempt:1,error_code:null},
      ...Array.from({length:30},(_,i) => ({...own,id:"job-"+i,owner_message_id:"completed-msg-"+i,
        status:"done",reply_message_id:"reply-"+i,heartbeat_at:date(i+1),
        created_at:date(i+1),attempt:1,error_code:null})),
    ];
    source.supervisor_proposals = [
      {...own,id:"old-proposal",capability_id:"purchase",status:"draft",effect_hash:"h",updated_at:date(0)},
      ...Array.from({length:30},(_,i) => ({...own,id:"rejected-"+i,capability_id:"purchase",
        status:"rejected",effect_hash:"h",updated_at:date(i+1)})),
    ];
    source.supervisor_investigations = [
      {...own,episode_id:"old-investigation",phase:"collect",failure_count:0,
        lease_token:null,lease_until:null,last_error:null,updated_at:date(0)},
      ...Array.from({length:30},(_,i) => ({...own,episode_id:"closed-"+i,
        phase:"resolved",failure_count:0,lease_token:null,lease_until:null,
        last_error:null,updated_at:date(i+1)})),
      {...own,business_id:"foreign-cafe",episode_id:"foreign",phase:"collect",updated_at:date(99)},
    ];
    client.mockResolvedValue(db);
    const response = await GET(new Request("https://example.org"),{params:Promise.resolve({threadId:thread})});
    expect(response.status).toBe(200);
    const work = (await response.json()).work;
    for (const item of ["run:old-run","job:old-job","proposal:old-proposal","investigation:old-investigation"])
      expect(work.map((w:{id:string})=>w.id)).toContain(item);
    expect(work.some((w:{id:string})=>w.id==="investigation:foreign")).toBe(false);
    expect(work.some((w:{proof?:{kind:string}|null})=>w.proof?.kind==="verified_effect")).toBe(false);
  });
  it("reports expired uncertain work without treating it as an active worker", async () => {
    const { db, source } = database();
    const now = Date.now();
    const earlier = new Date(now - 60_000).toISOString();
    const later = new Date(now + 60_000).toISOString();
    source.supervisor_runs = [{ id: "run-a", request_key: "owner-message", status: "running",
      final_report_ref: null, updated_at: earlier, finished_at: null }];
    const step = { run_id: "run-a", step_key: "owner_turn", step_index: 1, status: "leased",
      attempts: 1, error_code: null, updated_at: earlier, retry_mode: "reconcile", lease_until: earlier };
    source.supervisor_run_steps = [step];
    client.mockResolvedValue(db);
    const read = () => GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    const failedLease = await read();
    expect(failedLease.status).toBe(200);
    expect((await failedLease.json()).work).toMatchObject([{ id: "run:run-a", status: "uncertain", proof: null }]);
    source.supervisor_run_steps = [{ ...step, lease_until: later, attempts: 2 }];
    const recovered = await read();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).work).toMatchObject([{ id: "run:run-a", status: "retrying", proof: null }]);
  });
  it("never leaks work after a thread lookup denies ownership", async () => {
    const { db } = database();
    client.mockResolvedValue(db);
    const scope = await auth();
    scope.service.getThread.mockRejectedValue(new Error("not_owner"));
    auth.mockResolvedValue(scope);
    const response = await GET(new Request("https://example.org"), { params: Promise.resolve({ threadId: thread }) });
    expect(response.status).not.toBe(200);
    expect(client).not.toHaveBeenCalled();
  });
});

describe("POST /work scoped owner cancellation",()=>{
 const runId="123e4567-e89b-42d3-a456-426614174111";
 const post=(body:unknown,origin="https://example.org")=>POST(new Request("https://example.org/api/ai/work",{
   method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify(body)
 }),{params:Promise.resolve({threadId:thread})});
 it("cancels the exact authorized run without implying an in-flight effect was undone",async()=>{
   cancel.mockResolvedValue("uncertain");
   const response=await post({action:"cancel",runId});
   expect(response.status).toBe(200);
   expect(await response.json()).toEqual({state:"uncertain",runId});
   expect(cancel).toHaveBeenCalledWith({businessId:"cafe-a",ownerUserId:"owner-a",threadId:thread},runId);
 });
 it("does not accept another owner or cross-origin cancellation",async()=>{
   expect((await post({action:"cancel",runId,ownerUserId:"foreign"})).status).toBe(422);
   expect((await post({action:"cancel",runId},"https://foreign.example")).status).toBe(403);
   expect(cancel).not.toHaveBeenCalled();
 });
 it("does not expose a foreign run",async()=>{
   cancel.mockResolvedValue("not_found");
   expect((await post({action:"cancel",runId})).status).toBe(404);
 });
});

it("projects saved v2 waiting work even with execution disabled; never shows its implementation job as another assignment",async()=>{
  const {db,source}=database();
  source.supervisor_runs=[{id:"run",request_key:"owner-msg",status:"blocked",execution_version:2,awaiting_question_id:"question",owner_answer_ids:[],final_report_ref:null,updated_at:"2026-11-15",finished_at:null}];
  source.supervisor_run_steps=[{run_id:"run",step_key:"owner_turn",step_index:1,status:"blocked",attempts:1,error_code:"awaiting_owner",retry_mode:"reconcile",lease_until:null,checkpoint_phase:"ready"}];
  source.ai_agent_jobs=[{id:"job",durable_run_id:"run",owner_message_id:"owner-msg",status:"failed",error_code:"awaiting_owner",reply_message_id:null}];
  client.mockResolvedValue(db);
  const response=await GET(new Request("https://example.org"),{params:Promise.resolve({threadId:thread})});
  expect(await response.json()).toMatchObject({work:[{id:"run:run",status:"approval_required",questionId:"question",cancelAllowed:true}]});
});
