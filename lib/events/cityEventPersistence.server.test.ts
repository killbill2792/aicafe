import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {findCafeEventIdForCityEvent,linkCityEventToCafeEvent,
  recordCitySourceCoverage,upsertCafeNeighborhoodEvidence,upsertCityEventFact} from "./cityEventPersistence.server";

const A="11111111-1111-4111-8111-111111111111";
const B="22222222-2222-4222-8222-222222222222";
const OLD_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT_ID="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_EVENT_ID="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PLACE_ID="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const scope={city:"Berkeley",region:"CA",countryCode:"US"};
const candidate={...scope,name:"Jazz & Art Night",kind:"community" as const,
  startDate:"2026-11-07",sourceUrl:"https://city.example/jazz",
  venue:"Plaza",venueAddress:"12 Downtown St",checkedAt:"2026-11-02T12:00:00Z"};

/** Recorded-contract DB double: one transactional RPC is a single canonical
 * event/source write, not independent inserts that can leave half a fact. */
function storage(){
  const city=new Map<string,{id:string;identityKey:string;venue:string|null;
    venueKey:string|null;venueAddressKey:string|null;checkedAt:string;sources:Set<string>}>();
  const aliases=new Map<string,string>();
  const places=new Map<string,string>();
  const privateEvidence=new Map<string,{assessment:string;rationale:string|null}>();
  const links=new Map<string,string>();
  const legacy=new Map([[OLD_A,A],[OLD_B,B]]);
  const coverage=new Map<string,{status:string;checkedAt:string;completedAt:string|null}>();
  const calls:Array<{name:string;args:Record<string,unknown>}>= [];
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    calls.push({name,args});
    if(name==="ldi_upsert_city_event"){
      const key=String(args.p_identity_key),source=String(args.p_source_url);
      const keys=[args.p_source_identity_key,args.p_venue_identity_key]
        .filter((v):v is string=>typeof v==="string");
      const matches=new Set(keys.map(k=>aliases.get(k)).filter((v):v is string=>Boolean(v)));
      if(matches.size>1)return {data:null,error:{message:"city_event_identity_conflict_review_required"}};
      const id=[...matches][0]??[...city.values()].find(e=>e.identityKey===key)?.id??
        (city.size===0?EVENT_ID:OTHER_EVENT_ID);
      const current=city.get(id)??{id,identityKey:key,venue:null,
        venueKey:null,venueAddressKey:null,checkedAt:"",sources:new Set<string>()};
      if((current.venueKey&&args.p_venue_key&&current.venueKey!==args.p_venue_key)||
        (current.venueAddressKey&&args.p_venue_address_key&&
          current.venueAddressKey!==args.p_venue_address_key))
        return {data:null,error:{message:"city_event_venue_conflict_review_required"}};
      current.venue??=args.p_venue as string|null;
      current.venueKey??=args.p_venue_key as string|null;
      current.venueAddressKey??=args.p_venue_address_key as string|null;
      current.sources.add(source);
      if(String(args.p_checked_at)>current.checkedAt)current.checkedAt=String(args.p_checked_at);
      city.set(id,current);
      for(const alias of keys)aliases.set(alias,id);
      return {data:id,error:null};
    }
    if(name==="ldi_link_cafe_event"){
      const businessId=String(args.p_business_id),old=String(args.p_cafe_event_id);
      if(legacy.get(old)!==businessId)return {data:null,error:{message:"foreign key violation"}};
      const existing=links.get(old);
      if(existing&&existing!==args.p_city_event_id)
        return {data:null,error:{message:"legacy_event_identity_conflict"}};
      if([...links.entries()].some(([oldId,shared])=>
        oldId!==old&&legacy.get(oldId)===businessId&&shared===args.p_city_event_id))
        return {data:null,error:{message:"duplicate cafe event identity"}};
      links.set(old,String(args.p_city_event_id));
      return {data:old,error:null};
    }
    if(name==="ldi_upsert_cafe_neighborhood"){
      const key=String(args.p_identity_key);
      const place=places.get(key)??PLACE_ID;
      places.set(key,place);
      privateEvidence.set(String(args.p_business_id)+"|"+place,{
        assessment:String(args.p_assessment),rationale:args.p_rationale as string|null});
      return {data:place,error:null};
    }
    if(name==="ldi_record_city_coverage"){
      const key=[args.p_city_key,args.p_source_key,args.p_from,args.p_to].join("|");
      const at=String(args.p_checked_at),status=String(args.p_status);
      const old=coverage.get(key);
      coverage.set(key,{
        status:old&&at<old.checkedAt?old.status:status,
        checkedAt:old&&at<old.checkedAt?old.checkedAt:at,
        completedAt:status==="found"||status==="none_found"
          ?old?.completedAt&&old.completedAt>at?old.completedAt:at
          :old?.completedAt??null,
      });
      return {data:null,error:null};
    }
    return {data:null,error:{message:"unexpected RPC"}};
  });
  const from=vi.fn((table:string)=>({
    select:(cols:string)=>({
      eq:(field:string,value:string)=>({
        eq:(_nextField:string,otherValue:string)=>({
          maybeSingle:async()=>({
            data:table==="cafe_city_event_links"&&field==="business_id"
              ?[...links].find(([old,id])=>legacy.get(old)===value&&id===otherValue)
                ?{cafe_event_id:[...links].find(([old,id])=>
                  legacy.get(old)===value&&id===otherValue)?.[0]}:null
              :null,error:null,
          }),
        }),
      }),
    }),
  }));
  return {db:{rpc,from} as unknown as SupabaseClient,city,places,privateEvidence,
    links,legacy,coverage,aliases,calls,rpc,from};
}

describe("LDI A atomic shared persistence handoff",()=>{
  it("reconciles source variants to one city event, saves both sources, replays idempotently",async()=>{
    const s=storage();
    const a=await upsertCityEventFact(s.db,candidate);
    const b=await upsertCityEventFact(s.db,{...candidate,name:"Jazz and Art-Night!",
      sourceUrl:"https://venue.example/jazz"});
    const replay=await upsertCityEventFact(s.db,candidate);
    expect(a).toMatchObject({cityEventId:EVENT_ID,cityKey:"us|ca|berkeley"});
    expect(b.identityKey).toBe(a.identityKey);
    expect(replay).toEqual(a);
    expect(s.city.size).toBe(1);
    expect([...s.city.values()][0].sources).toEqual(new Set([
      "https://city.example/jazz","https://venue.example/jazz"]));
    expect(s.calls.filter(c=>c.name==="ldi_upsert_city_event")).toHaveLength(3);
    expect(s.calls.some(c=>c.args.p_business_id!==undefined&&c.name==="ldi_upsert_city_event")).toBe(false);
  });
  it("enriches a source-backed unknown venue without changing its canonical UUID",async()=>{
    const s=storage();
    const initial=await upsertCityEventFact(s.db,{...candidate,venue:null,venueAddress:null});
    const named=await upsertCityEventFact(s.db,{...candidate,venue:"Plaza",venueAddress:null});
    const addressed=await upsertCityEventFact(s.db,candidate);
    const corroborated=await upsertCityEventFact(s.db,{...candidate,
      sourceUrl:"https://organizer.example/jazz"});
    expect(named.cityEventId).toBe(initial.cityEventId);
    expect(addressed.cityEventId).toBe(initial.cityEventId);
    expect(corroborated.cityEventId).toBe(initial.cityEventId);
    expect(s.city.size).toBe(1);
    expect(s.aliases.size).toBe(3); // first source, confirmed venue, second source
    expect([...s.city.values()][0].sources).toEqual(new Set([
      "https://city.example/jazz","https://organizer.example/jazz"]));
  });
  it("never conflates two separately named halls at the same address",async()=>{
    const s=storage();
    const one=await upsertCityEventFact(s.db,{...candidate,name:"Community Open Day",
      venue:"Central Hall",venueAddress:"100 Center St"});
    const two=await upsertCityEventFact(s.db,{...candidate,name:"Community Open Day",
      venue:"West Hall",venueAddress:"100 Center St",
      sourceUrl:"https://west.example/open-day"});
    expect(one.identityKey).not.toBe(two.identityKey);
    expect(one.cityEventId).not.toBe(two.cityEventId);
    expect(s.city.size).toBe(2);
  });
  it("refuses conflicting verified halls from the same source",async()=>{
    const s=storage();
    await upsertCityEventFact(s.db,{...candidate,venue:"Central Hall"});
    await expect(upsertCityEventFact(s.db,{...candidate,venue:"West Hall"}))
      .rejects.toMatchObject({message:"city_event_venue_conflict_review_required"});
    expect(s.city.size).toBe(1);
  });
  it("rejects conflicting addresses before attaching a second venue alias",async()=>{
    const s=storage();
    const one=await upsertCityEventFact(s.db,{...candidate,venue:"Central Hall",
      venueAddress:"100 Center St"});
    await expect(upsertCityEventFact(s.db,{...candidate,venue:"Central Hall",
      venueAddress:"101 Center St"}))
      .rejects.toMatchObject({message:"city_event_venue_conflict_review_required"});
    expect(s.city.size).toBe(1);
    expect(s.aliases.size).toBe(2);
    expect([...s.city.values()][0].venueAddressKey).toBe("100 center st");
    expect((await upsertCityEventFact(s.db,{...candidate,venue:"Central Hall",
      venueAddress:"100 Center St"})).cityEventId).toBe(one.cityEventId);
  });
  it("reconciles the same venue despite accents and ampersand spellings",async()=>{
    const s=storage();
    const a=await upsertCityEventFact(s.db,{...candidate,venue:"Arts & Culture Hall"});
    const b=await upsertCityEventFact(s.db,{...candidate,venue:"Arts and Culture Hall",
      sourceUrl:"https://organizer.example/jazz"});
    const c=await upsertCityEventFact(s.db,{...candidate,venue:"Árts and Culture Hall",
      sourceUrl:"https://campus.example/jazz"});
    expect(b.cityEventId).toBe(a.cityEventId);
    expect(c.cityEventId).toBe(a.cityEventId);
    expect(s.city.size).toBe(1);
  });
  it("does not fuse a different venue and preserves legacy UUIDs and approvals",async()=>{
    const s=storage(),history={proposalEventIds:[OLD_A],approved:true,reportId:"existing-report"};
    const original=await upsertCityEventFact(s.db,candidate);
    const other=await upsertCityEventFact(s.db,{...candidate,venueAddress:"14 Downtown St"});
    expect(original.identityKey).not.toBe(other.identityKey);
    await expect(linkCityEventToCafeEvent(s.db,{businessId:A,cafeEventId:OLD_A,
      cityEventId:original.cityEventId})).resolves.toBe(OLD_A);
    await expect(linkCityEventToCafeEvent(s.db,{businessId:A,cafeEventId:OLD_A,
      cityEventId:original.cityEventId})).resolves.toBe(OLD_A);
    await expect(linkCityEventToCafeEvent(s.db,{businessId:A,cafeEventId:OLD_A,
      cityEventId:PLACE_ID})).rejects.toMatchObject({message:"legacy_event_identity_conflict"});
    expect(history).toEqual({proposalEventIds:[OLD_A],approved:true,reportId:"existing-report"});
    expect(s.links.get(OLD_A)).toBe(EVENT_ID);
  });
  it("enforces business-scoped legacy links and lookup, never reassigns a cafe's row",async()=>{
    const s=storage();
    await upsertCityEventFact(s.db,candidate);
    await linkCityEventToCafeEvent(s.db,{businessId:A,cafeEventId:OLD_A,cityEventId:EVENT_ID});
    await linkCityEventToCafeEvent(s.db,{businessId:B,cafeEventId:OLD_B,cityEventId:EVENT_ID});
    expect(await findCafeEventIdForCityEvent(s.db,{businessId:A,cityEventId:EVENT_ID})).toBe(OLD_A);
    expect(await findCafeEventIdForCityEvent(s.db,{businessId:B,cityEventId:EVENT_ID})).toBe(OLD_B);
    await expect(linkCityEventToCafeEvent(s.db,{businessId:B,cafeEventId:OLD_A,
      cityEventId:EVENT_ID})).rejects.toMatchObject({message:"foreign key violation"});
    expect(s.links).toEqual(new Map([[OLD_A,EVENT_ID],[OLD_B,EVENT_ID]]));
  });
  it("stores one public place but two private, cafe-scoped assessments",async()=>{
    const s=storage();
    const place={...scope,name:"Central Campus",kind:"university" as const,
      address:"20 University Ave",sourceUrl:"https://campus.example/about",
      checkedAt:"2026-11-02T13:00:00Z"};
    expect(await upsertCafeNeighborhoodEvidence(s.db,{...place,businessId:A,
      assessment:"potential",rationale:"Students may visit nearby"}))
      .toEqual({placeId:PLACE_ID,cityKey:"us|ca|berkeley"});
    await upsertCafeNeighborhoodEvidence(s.db,{...place,businessId:B,
      assessment:"unknown",rationale:null});
    expect(s.places.size).toBe(1);
    expect(s.privateEvidence.get(A+"|"+PLACE_ID)).toEqual({
      assessment:"potential",rationale:"Students may visit nearby"});
    expect(s.privateEvidence.get(B+"|"+PLACE_ID)).toEqual({
      assessment:"unknown",rationale:null});
    expect(s.calls.filter(c=>c.name==="ldi_upsert_cafe_neighborhood")
      .every(c=>c.args.p_business_id!==undefined)).toBe(true);
    expect(s.calls.find(c=>c.name==="ldi_upsert_cafe_neighborhood")?.args)
      .not.toHaveProperty("p_owner_facts");
  });
  it("remembers completed source coverage when a later attempt fails or is partial",async()=>{
    const s=storage();
    const base={...scope,sourceKey:"city-official",from:"2026-11-02",to:"2026-11-15",
      checkedAt:"2026-11-02T10:00:00Z"};
    await recordCitySourceCoverage(s.db,{...base,status:"found"});
    await recordCitySourceCoverage(s.db,{...base,status:"found"});
    await recordCitySourceCoverage(s.db,{...base,status:"failed",checkedAt:"2026-11-03T10:00:00Z"});
    await recordCitySourceCoverage(s.db,{...base,status:"partial",checkedAt:"2026-11-02T08:00:00Z"});
    expect([...s.coverage.values()]).toEqual([{
      status:"failed",checkedAt:"2026-11-03T10:00:00.000Z",
      completedAt:"2026-11-02T10:00:00.000Z"}]);
    expect(s.coverage.size).toBe(1);
  });
  it("rejects wrong time, event source and cafe ID before touching storage",async()=>{
    const s=storage();
    await expect(upsertCityEventFact(s.db,{...candidate,checkedAt:"not-a-date"})).rejects.toThrow();
    await expect(upsertCityEventFact(s.db,{...candidate,sourceUrl:"http://unsafe.example"})).rejects.toThrow();
    await expect(linkCityEventToCafeEvent(s.db,{businessId:"other-cafe",cafeEventId:OLD_A,
      cityEventId:EVENT_ID})).rejects.toThrow();
    expect(s.calls).toHaveLength(0);
  });
});
