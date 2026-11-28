// Local cutover rehearsal. Run with Node 24 against a disposable migrated database.
import pg from "pg";
import {retainProviderPayload} from "../lib/externalData/retainPayload.ts";

// Keep PostgreSQL's original numeric precision even when another key is scrubbed.
pg.types.setTypeParser(pg.types.builtins.JSONB,text=>JSON.parse(text,(_key,value,context)=>
  typeof value==="number"&&String(value)!==context.source ? JSON.rawJSON(context.source) : value));

const connectionString=process.env.SUPABASE_DB_URL;
if (!connectionString || !["127.0.0.1","localhost","[::1]"].includes(new URL(connectionString).hostname)) {
  throw new Error("Set SUPABASE_DB_URL to the disposable local Supabase database");
}

function cleanDelta(changes) {
  return changes.flatMap(change => {
    const segments=change.segments??change.path?.match(/[^.[\]]+/g)??[];
    const values={...change};
    for (const side of ["before","after"]) {
      if (!(side in change)) continue;
      const object=segments.reduceRight((child,key)=>Object.fromEntries([[key,child]]),change[side]);
      const safe=retainProviderPayload(object);
      let child=safe;
      for (const key of segments) {
        if (!child || !Object.hasOwn(child,key)) return [];
        child=child[key];
      }
      values[side]=child;
    }
    return [values];
  });
}

const db=new pg.Client({connectionString,application_name:"external_history_cutover_rehearsal"});
const summary={records:0,changes:0,unattributedRecords:0,unattributedChanges:0};
try {
  await db.connect();
  await db.query("set lock_timeout='5s'");
  let last=null;
  for (;;) {
    await db.query("begin");
    const {rows}=await db.query(`
      select r.business_id,r.provider,r.id,r.restaurant_guid,r.entity_guid,r.payload_sha256,r.payload,
             r.capture_key, r.payload->>'provider_key' as provider_key
      from public.external_records r
      where r.source_account is null and r.restaurant_guid is not null and ($1::uuid is null or r.id>$1)
        and exists(select from public.toast_location_mappings m
          where (m.business_id,m.restaurant_guid)=(r.business_id,r.restaurant_guid)
            and (m.verified_at is not null or m.info_refreshed_at is not null))
      order by r.id limit 250 for update`,[last]);
    if (!rows.length) { await db.query("commit"); break; }
    for (const row of rows) {
      const payload=retainProviderPayload(row.payload);
      const adopted=await db.query(`select public.external_adopt_historical_record($1,$2,$3,$4,$5,$6,$7,$8) as saved`,[
        row.business_id,row.provider,row.id,row.payload_sha256,JSON.stringify(payload),
        row.restaurant_guid,row.provider_key??row.entity_guid??row.capture_key,row.capture_key.startsWith("stage:"),
      ]);
      if (adopted.rows[0].saved) summary.records++;
    }
    await db.query("commit");
    last=rows.at(-1).id;
  }
  last=null;
  for (;;) {
    await db.query("begin");
    const {rows}=await db.query(`
      select c.business_id,c.provider,c.id,c.changes,c.restaurant_guid,c.record_id,c.source_key,
             c.entity_guid,r.id as matched_id,r.source_key as matched_key,r.payload_origin
      from public.external_record_changes c
      left join lateral (
        select (array_agg(a.id))[1] as id,(array_agg(a.source_key))[1] as source_key,
               (array_agg(a.payload_origin))[1] as payload_origin
        from public.external_records a
        where (a.business_id,a.provider,a.restaurant_guid,a.entity)=(c.business_id,c.provider,c.restaurant_guid,c.entity)
          and a.source_account is not null and
          (a.id=c.record_id or (c.record_id is null and a.entity_guid=c.entity_guid
            and a.business_date is not distinct from c.business_date))
        having count(*)=1
      ) r on true
      where c.source_account is null and c.restaurant_guid is not null and ($1::bigint is null or c.id>$1)
        and exists(select from public.toast_location_mappings m
          where (m.business_id,m.restaurant_guid)=(c.business_id,c.restaurant_guid)
            and (m.verified_at is not null or m.info_refreshed_at is not null))
      order by c.id limit 250 for update of c`,[last]);
    if (!rows.length) { await db.query("commit"); break; }
    for (const row of rows) {
      const changed=await db.query(`update public.external_record_changes
        set source_account=$4,source_key=$5,record_id=$6,changes=$7,delta_origin=$8
        where (business_id,provider,id)=($1,$2,$3) and source_account is null`,[
        row.business_id,row.provider,row.id,row.restaurant_guid,
        row.source_key??row.matched_key??row.entity_guid,row.record_id??row.matched_id,
        JSON.stringify(cleanDelta(row.changes)),
        row.payload_origin==="historical_projection"?"historical_projection":"historical_provider",
      ]);
      summary.changes+=changed.rowCount;
    }
    await db.query("commit");
    last=rows.at(-1).id;
  }
  const {rows:[remaining]}=await db.query(`select
    (select count(*)::int from public.external_records where source_account is null) as records,
    (select count(*)::int from public.external_record_changes where source_account is null) as changes`);
  summary.unattributedRecords=remaining.records;
  summary.unattributedChanges=remaining.changes;
  console.log(JSON.stringify(summary));
} catch (error) {
  await db.query("rollback").catch(()=>{});
  console.error("External history rehearsal failed",error.code??error.name);
  process.exitCode=1;
} finally {
  await db.end();
}
