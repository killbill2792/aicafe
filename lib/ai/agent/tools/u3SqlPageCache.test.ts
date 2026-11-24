import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {ResearchPageCache,ResearchPageCollector} from "./u3SqlPageCache";

const snapshot={id:"snapshot",digest:"digest",asOf:"2026-11-24T00:00:00Z",totalRows:3};
const input=[{id:1,amount:"123"},{id:2,amount:"456"},{id:3,amount:"789"}];
function collect(rows:unknown[],capacity?:number){
 const collector=new ResearchPageCollector(capacity);
 for(const row of rows)collector.add(row,Buffer.byteLength(JSON.stringify(row),"utf8"));
 return collector.finish();
}
describe("bounded immutable SQL result transport",()=>{
 it("returns only the requested page from the exact original result",()=>{
  const cache=new ResearchPageCache();
  const original=input.map(row=>({...row}));
  cache.remember(snapshot,collect(original));
  original[1].amount="changed";
  const page=cache.read(snapshot,1,1,1000);
  expect(page).toMatchObject({rows:[input[1]],totalRows:3,truncated:true,digest:"digest"});
  expect(cache.read(snapshot,2,null,1000)).toMatchObject({rows:[input[2]],truncated:false});
  expect(cache.read(snapshot,1,null,2)).toMatchObject({rows:[],truncated:true});
  expect(cache.read({...snapshot,digest:"different"},1,null,1000)).toBeNull();
 });
 it("does not retain over-budget results or return expired observations",()=>{
  let now=0;const cache=new ResearchPageCache(4096,100,()=>now);
  cache.remember(snapshot,collect(input,1));
  expect(cache.read(snapshot,1,null,1000)).toBeNull();
  cache.remember(snapshot,collect(input));
  expect(cache.read(snapshot,1,null,1000)).not.toBeNull();
  now=101;
  expect(cache.read(snapshot,1,null,1000)).toBeNull();
 });
 it("keeps dates and numeric strings in their original driver representation",()=>{
  const cache=new ResearchPageCache();
  const row={at:new Date(snapshot.asOf),cents:"9007199254740993"};
  const one={...snapshot,totalRows:1};
  cache.remember(one,collect([row]));
  expect(cache.read(one,0,null,1000)?.rows).toEqual([row]);
 });
});
