import {randomUUID} from "node:crypto";
import {Client} from "pg";
import {describe,expect,it} from "vitest";

/** Real Postgres RLS integration. Run ONLY against a disposable database after
 * staging migration 137, with two EXISTING owner memberships:
 * LDI_RLS_SANDBOX_ONLY=1 LDI_TEST_DATABASE_URL=postgres://...
 * LDI_RLS_BUSINESS_A=... LDI_RLS_OWNER_A=...
 * LDI_RLS_BUSINESS_B=... LDI_RLS_OWNER_B=... npm test -- cityEventPersistence.rls
 * Every fixture write is within a transaction that ALWAYS rolls back.
 * Absent explicit sandbox flags, ordinary CI safely skips this test. */
const settings={
  url:process.env.LDI_TEST_DATABASE_URL??"",
  businessA:process.env.LDI_RLS_BUSINESS_A??"",
  businessB:process.env.LDI_RLS_BUSINESS_B??"",
  ownerA:process.env.LDI_RLS_OWNER_A??"",
  ownerB:process.env.LDI_RLS_OWNER_B??"",
};
const enabled=process.env.LDI_RLS_SANDBOX_ONLY==="1"&&
  Object.values(settings).every(Boolean);
describe("LDI A real PostgreSQL owner RLS (disposable database)",()=>{
  (enabled?it:it.skip)("shares city facts but isolates links and neighborhood assessments",async()=>{
    const db=new Client({connectionString:settings.url});
    await db.connect();
    try{
      await db.query("begin");
      const members=await db.query(
        "select business_id,user_id from public.memberships where role='owner' "+
        "and ((business_id=$1 and user_id=$2) or (business_id=$3 and user_id=$4))",
        [settings.businessA,settings.ownerA,settings.businessB,settings.ownerB]);
      expect(members.rows).toHaveLength(2);
      const hex=randomUUID().replace(/-/gu,"").repeat(2);
      const event=await db.query(
        "insert into public.city_events(city_key,identity_key,name,kind,start_date,end_date,last_checked_at) "+
        "values('us|ca|berkeley',$1,'RLS fixture event','community','2035-01-15','2035-01-15',now()) returning id",
        [hex]);
      const cityId=event.rows[0].id as string;
      const place=await db.query(
        "insert into public.city_places(city_key,identity_key,name,kind,source_url,last_checked_at) "+
        "values('us|ca|berkeley',$1,'RLS fixture campus','university','https://example.org/campus',now()) returning id",
        [randomUUID().replace(/-/gu,"").repeat(2)]);
      const placeId=place.rows[0].id as string;
      await db.query(
        "insert into public.city_event_sources(city_event_id,source_url,observed_name,observed_at) "+
        "values($1,'https://example.org/event','RLS fixture event',now())",[cityId]);
      for(const businessId of [settings.businessA,settings.businessB]){
        const legacy=await db.query(
          "insert into public.cafe_events(business_id,name,kind,start_date,end_date,source_url) "+
          "values($1,'RLS fixture event','community','2035-01-15','2035-01-15','https://example.org/event') returning id",
          [businessId]);
        await db.query(
          "insert into public.cafe_city_event_links(business_id,cafe_event_id,city_event_id) values($1,$2,$3)",
          [businessId,legacy.rows[0].id,cityId]);
        await db.query(
          "insert into public.cafe_neighborhood_evidence(business_id,place_id,assessment,rationale,checked_at) "+
          "values($1,$2,$3,$4,now())",
          [businessId,placeId,businessId===settings.businessA?"potential":"unknown",
            businessId===settings.businessA?"Cafe A only hypothesis":"Cafe B only hypothesis"]);
      }
      await db.query("set local role authenticated");
      for(const [owner,businessId,other] of [
        [settings.ownerA,settings.businessA,settings.businessB],
        [settings.ownerB,settings.businessB,settings.businessA],
      ]){
        await db.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
        expect((await db.query("select auth.uid() as uid")).rows[0].uid).toBe(owner);
        expect((await db.query("select id from public.city_events where id=$1",[cityId])).rows)
          .toHaveLength(1);
        expect((await db.query("select city_event_id from public.city_event_sources where city_event_id=$1",[cityId])).rows)
          .toHaveLength(1);
        expect((await db.query("select id from public.city_places where id=$1",[placeId])).rows)
          .toHaveLength(1);
        const links=await db.query(
          "select business_id from public.cafe_city_event_links where city_event_id=$1",[cityId]);
        expect(links.rows.map(r=>r.business_id)).toEqual([businessId]);
        expect(links.rows.some(r=>r.business_id===other)).toBe(false);
        const privateRows=await db.query(
          "select business_id,rationale from public.cafe_neighborhood_evidence where place_id=$1",[placeId]);
        expect(privateRows.rows).toHaveLength(1);
        expect(privateRows.rows[0].business_id).toBe(businessId);
        expect(privateRows.rows[0].rationale).toBe(
          businessId===settings.businessA?"Cafe A only hypothesis":"Cafe B only hypothesis");
      }
      await db.query("savepoint denied_write");
      await expect(db.query(
        "insert into public.city_events(city_key,identity_key,name,kind,start_date,end_date,last_checked_at) "+
        "values('us|ca|berkeley',$1,'Unauthorized','other','2035-01-16','2035-01-16',now())",
        [randomUUID().replace(/-/gu,"").repeat(2)])).rejects.toThrow();
      await db.query("rollback to savepoint denied_write");

      // Legacy event deletion (including business/account cascade) deletes
      // the association, never the independent public city fact.
      await db.query("reset role");
      const legacyForA=await db.query(
        "select cafe_event_id from public.cafe_city_event_links where business_id=$1 and city_event_id=$2",
        [settings.businessA,cityId]);
      expect(legacyForA.rows).toHaveLength(1);
      await db.query(
        "delete from public.cafe_events where business_id=$1 and id=$2",
        [settings.businessA,legacyForA.rows[0].cafe_event_id]);
      expect((await db.query(
        "select cafe_event_id from public.cafe_city_event_links where business_id=$1 and city_event_id=$2",
        [settings.businessA,cityId])).rows).toHaveLength(0);
      expect((await db.query("select id from public.city_events where id=$1",[cityId])).rows)
        .toHaveLength(1);

    }finally{
      await db.query("rollback");
      await db.end();
    }
  });
});
