import {describe,expect,it} from "vitest";
import {researchNextCursor,researchPageOffset,researchPage} from "./u3SqlCursor";
const snapshot={id:"11111111-1111-4111-8111-111111111111",digest:"a".repeat(64),
 asOf:"2026-11-24T00:00:00.000Z",totalRows:2500};
const key="synthetic service signing key secret at least 24 chars";
const input={
 businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
 threadId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 mode:"owner",sourceType:null,sourceId:null,runId:null,leaseToken:null,
 sql:"SELECT business_date, sum(net_sales_cents) AS cents FROM u3_research.daily_rollups GROUP BY business_date ORDER BY business_date",
 parameters:[30] as Array<string|number|boolean|null>,
 date_from:"2023-01-01",date_to:"2026-11-23",limit:100
};
describe("U3 server-signed research cursor",()=>{
 it("walks arbitrarily long owner-chosen historical SQL without a total row ceiling",()=>{
  expect(researchPageOffset(input,null,key)).toBe(0);
  let offset=0;
  for(let page=0;page<20;page++){
   const cursor=researchNextCursor(input,offset+100,key,snapshot);
   offset=researchPageOffset(input,cursor,key);
   expect(offset).toBe((page+1)*100);
  }
  expect(offset).toBe(2000);
 });
 it("binds every cursor to SQL, parameters, window, owner/café/thread and lease",()=>{
  const cursor=researchNextCursor(input,150,key,snapshot);
  const attempts=[
   {...input,businessId:"another-cafe"},
   {...input,ownerUserId:"other"},
   {...input,threadId:"other"},
   {...input,sql:"SELECT * FROM u3_research.orders"},
   {...input,parameters:[31]},
   {...input,date_to:"2026-11-24"},
   {...input,mode:"investigation",sourceType:"alert",sourceId:"a",leaseToken:"lease"},
   {...input,limit:50},{...input,aggregateOnly:true}
  ];
  for(const p of attempts)expect(()=>researchPageOffset(p,cursor,key)).toThrow("invalid_query");
 });
 it("continues the same durable snapshot across a revalidated replacement lease, never another run",()=>{
  const first={...input,mode:"durable",runId:"run-a",leaseToken:"old"};
  const cursor=researchNextCursor(first,150,key,snapshot);
  expect(researchPageOffset({...first,leaseToken:"replacement"},cursor,key)).toBe(150);
  expect(()=>researchPageOffset({...first,runId:"run-b",leaseToken:"replacement"},cursor,key)).toThrow("invalid_query");
  const investigation={...input,mode:"investigation",sourceType:"alert",sourceId:"a",leaseToken:"old"};
  const restricted=researchNextCursor(investigation,150,key,snapshot);
  expect(()=>researchPageOffset({...investigation,leaseToken:"replacement"},restricted,key)).toThrow("invalid_query");
 });
 it("rejects crafted, tampered, malformed, unsigned and overflowing offsets",()=>{
  const cursor=researchNextCursor(input,7,key,snapshot);
  for(const attempt of [cursor.slice(0,-1)+(cursor.endsWith("A")?"B":"A"),"junk",
   "abc."+("A".repeat(43)),"",cursor+"bad"])
   expect(()=>researchPageOffset(input,attempt,key)).toThrow("invalid_query");
  expect(()=>researchPageOffset(input,cursor,"different long service signing secret")).toThrow("invalid_query");
  for(const offset of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity])
   expect(()=>researchNextCursor(input,offset,key,snapshot)).toThrow("invalid_query");
 });
 it("does not expose source text, café ID or the secret in the cursor",()=>{
  const cursor=researchNextCursor(input,100,key,snapshot);
  expect(cursor).not.toContain(input.businessId);
  expect(cursor).not.toContain("net_sales_cents");
  expect(cursor).not.toContain(key);
  const payload=JSON.parse(Buffer.from(cursor.split(".")[0],"base64url").toString("utf8"));
  expect(Object.keys(payload).sort()).toEqual(["h","o","s","v"]);
  expect(researchPage(input,cursor,key)).toEqual({offset:100,snapshot});
 });
});
