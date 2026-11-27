// Read-only pre-cutover inventory. Does not print credentials or provider payloads.
import pg from "pg";

const connectionString=process.env.SUPABASE_READONLY_DB_URL;
const cafe=process.argv[2];
if (!connectionString || !cafe) throw new Error("Set SUPABASE_READONLY_DB_URL and pass the exact café name");
const url=new URL(connectionString);
const loopback=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
if (!loopback && !["verify-full",null].includes(url.searchParams.get("sslmode"))) {
  throw new Error("Use certificate-verified TLS for the read-only database connection");
}
const db=new pg.Client({connectionString,ssl:loopback ? undefined : {rejectUnauthorized:true},
  connectionTimeoutMillis:10000,application_name:"external_source_readonly_parity"});
try {
  await db.connect();
  await db.query("begin isolation level repeatable read read only");
  await db.query("set local statement_timeout='30s'");
  const businesses=await db.query("select id from public.businesses where name=$1",[cafe]);
  if(businesses.rowCount!==1)throw new Error("The café name did not resolve uniquely");
  const scope=[businesses.rows[0].id];
  const report={};
  const {rows:[schema]}=await db.query(`select
    to_regclass('public.external_records') is not null as shared_archive,
    to_regclass('public.toast_order_typed_facts') is not null as typed_order_copy`);
  report.archive=(await db.query(`select entity,count(*)::bigint as records,
    count(entity_guid)::bigint as identified,min(first_seen) as first_seen,max(last_seen) as last_seen
    from public.toast_raw_records where business_id=$1 group by entity order by entity`,scope)).rows;
  report.connections=(await db.query(`select count(*)::int as verified_locations from public.toast_location_mappings
    where business_id=$1 and verified_at is not null`,scope)).rows[0];
  report.order_coverage=(await db.query(`select count(*)::int as normalized_orders,
   count(*) filter(where not exists(select from public.toast_raw_records r where r.business_id=o.business_id
      and r.entity='order' and o.pos_order_id='toast:'||r.restaurant_guid||':'||r.entity_guid
      and r.business_date=o.business_date and r.superseded_by is null))::int as missing_raw
   from public.orders o where o.business_id=$1 and o.pos_order_id like 'toast:%'`,scope)).rows[0];
  if(schema.typed_order_copy) {
    // Report prerequisites while the previous schema is still active. On that
    // schema source_account does not exist and every certified row needs review.
    const affiliation=schema.shared_archive ? "r.source_account is null" : "true";
    report.typed_order_retirement=(await db.query(`select count(*)::int as certified_rows,
      count(*) filter(where r.id is null or r.run_id is distinct from t.run_id or
        r.superseded_by is not null or r.entity is distinct from 'order' or
        r.entity_guid is distinct from t.order_guid or
        r.payload->>'guid' is distinct from t.order_guid::text or
        jsonb_typeof(r.payload->'checks') is distinct from 'array')::int as invalid_source_links,
      count(*) filter(where ${affiliation})::int as source_affiliation_needed
      from public.toast_order_typed_facts t
      join public.toast_day_status d on (d.business_id,d.restaurant_guid,d.business_date,d.last_import_run_id)=
        (t.business_id,t.restaurant_guid,t.business_date,t.run_id) and d.import_state='imported'
      left join public.toast_raw_records r on (r.business_id,r.id)=(t.business_id,t.raw_record_id)
      where t.business_id=$1`,scope)).rows[0];
  }
  report.labor_history=(await db.query(`select count(*)::int as retained_time_entries,
    count(*) filter(where payload ? 'inDate' and not (payload ? 'clock_in'))::int as original_clock_fields,
    count(*) filter(where payload ? 'clock_in')::int as projected_clock_fields
    from public.toast_raw_records where business_id=$1 and entity='time_entry' and superseded_by is null`,scope)).rows[0];
  report.schedule_history=(await db.query(`select count(*)::int as saved_toast_shifts,
    count(*) filter(where p.deleted)::int as deleted_shifts,
    count(*) filter(where exists(
      select from public.toast_raw_records r
      join public.toast_location_mappings m on (m.business_id,m.restaurant_guid)=(r.business_id,r.restaurant_guid)
      where m.verified_at is not null and (m.business_id,m.location_id)=(p.business_id,p.location_id)
        and r.entity in ('shift','scheduled_shift','labor/v1/shifts') and r.superseded_by is null
        and r.entity_guid::text=p.external_shift_id and r.payload->>'guid'=p.external_shift_id
        and jsonb_typeof(r.payload->'inDate')='string' and jsonb_typeof(r.payload->'outDate')='string'
    ))::int as shifts_with_retained_original
    from public.pos_scheduled_shifts p where p.business_id=$1 and p.provider='toast'`,scope)).rows[0];
  if (schema.shared_archive) {
  report.analytics=(await db.query(`select count(*)::int as metrics,
    count(*) filter(where not exists(select from public.toast_raw_records r where r.business_id=a.business_id
      and r.restaurant_guid=a.restaurant_guid and r.business_date=a.business_date and r.entity='analytics_report'
      and r.entity_guid::text=a.payload->'value_json'->>'requestGuid'
      and (a.payload->>'value_numeric')::numeric is not distinct from
      case a.payload->>'metric' when 'orders_count' then (r.payload->>'ordersCount')::numeric
      when 'void_orders_count' then (r.payload->>'voidOrdersCount')::numeric
      when 'discount_cents' then round((r.payload->>'discountAmount')::numeric*100)
      when 'refund_cents' then round((r.payload->>'refundAmount')::numeric*100)
      when 'void_orders_amount_cents' then round((r.payload->>'voidOrdersAmount')::numeric*100)
      when 'net_sales_cents' then round((r.payload->>'netSalesAmount')::numeric*100) end))::int as unmatched_metrics
    from public.external_records a where business_id=$1 and provider='toast'
      and entity='historical_analytics_metric' and payload->>'report'='metrics/day'`,scope)).rows[0];
  }
  await db.query("rollback");
  console.log(JSON.stringify(report,null,2));
  if(!report.connections.verified_locations || !report.archive.length || report.order_coverage.missing_raw ||
     report.analytics?.unmatched_metrics || report.typed_order_retirement?.invalid_source_links ||
     report.typed_order_retirement?.source_affiliation_needed)process.exitCode=2;
} catch(error) {
  console.error("Read-only parity check failed",error.code ?? error.name);
  process.exitCode=1;
} finally {
  await db.end();
}
