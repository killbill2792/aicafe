// Requires Node 24 and a trusted maintenance connection. Default is a read-only
// assessment. Run with --apply against the explicitly selected database to adopt rows.
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {pathToFileURL} from "node:url";
import pg from "pg";
import {retainProviderPayload} from "../lib/externalData/retainPayload.ts";

// Never let JSON.parse round an original amount into a different value when
// deciding whether a record or historical change already conforms to retention.
function parseExactJson(text) {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === "number" && String(value) !== context.source ? JSON.rawJSON(context.source) : value);
}

const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const legacyPath = /^(?:\.[A-Za-z0-9_-]+(?:\[(?:[0-9]+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\])*)+$/i;
const deltaFields = new Set(["path", "segments", "before", "after", "before_present", "after_present"]);

function safePayload(value) {
  try {
    return isDeepStrictEqual(value, retainProviderPayload(value));
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function safeChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change) ||
      Object.keys(change).some(key => !deltaFields.has(key)) ||
      !["before", "after"].some(side => Object.hasOwn(change, side))) return false;

  const segments = Object.hasOwn(change, "segments") ? change.segments
    : change.path === "$" ? []
    : typeof change.path === "string" && legacyPath.test(change.path) ? change.path.match(/[^.[\]]+/g)
    : null;
  if (!Array.isArray(segments) || !segments.every(segment => typeof segment === "string" && safePayload(segment))) return false;
  if (Object.hasOwn(change, "path") && (typeof change.path !== "string" || !safePayload(change.path))) return false;

  // Check each value in its original path context, including payment and card
  // containers. Preserve legacy path notation and presence markers verbatim.
  return ["before", "after"].every(side => {
    if (Object.hasOwn(change, side + "_present") &&
        typeof change[side + "_present"] !== "boolean") return false;
    if (!Object.hasOwn(change, side)) return !Object.hasOwn(change, side + "_present");
    return safePayload(segments.reduceRight((child, key) => ({[key]: child}), change[side]));
  });
}

const mapped = (alias, account = "restaurant_guid") => `exists (
  select from public.toast_location_mappings m
  where (m.business_id, m.restaurant_guid) = (${alias}.business_id, ${alias}.${account})
    and m.verified_at is not null
)`;

// Some old void staging rows lacked a restaurant column. The same-café
// original must independently contain both the order GUID and the voided
// selection, and the staged location must match the verified mapping.
const voidAccount = alias => `(
  select (array_agg(o.restaurant_guid))[1]
  from public.external_records o join public.toast_location_mappings m
    on (m.business_id, m.restaurant_guid) = (o.business_id, o.restaurant_guid)
  where ${alias}.restaurant_guid is null and ${alias}.entity = 'void'
    and ${alias}.capture_key like 'stage:toast_void_facts:%'
    and m.verified_at is not null and m.location_id = public.toast_uuid_or_null(${alias}.payload->>'location_id')
    and o.provider = 'toast' and o.entity = 'order' and o.business_id = ${alias}.business_id
    and o.entity_guid = public.toast_uuid_or_null(${alias}.payload->>'order_guid')
    and o.source_account = o.restaurant_guid::text and o.source_key = o.entity_guid::text
    and o.superseded_by is null and o.payload_origin in ('provider', 'historical_provider')
    and ${alias}.payload->>'selection_guid' = ${alias}.entity_guid::text
    and jsonb_path_exists(o.payload, '$.checks[*].selections[*] ? (@.guid == $guid)',
      jsonb_build_object('guid', ${alias}.entity_guid::text))
  having count(*) = 1
)`;

const records = lock => `
  with page as materialized (
    select business_id, id, restaurant_guid, entity, entity_guid, capture_key, payload_sha256,
      payload, superseded_by, capture_key like 'stage:%' as projected,
      case when capture_key like 'stage:%' then capture_key else entity_guid::text end as record_key
    from public.external_records
    where provider = 'toast' and source_account is null and ($1::uuid is null or id > $1)
    order by id limit $2${lock}
  ), scoped as (
    select p.*, coalesce(p.restaurant_guid, ${voidAccount("p")}) as account from page p
  )
  select p.business_id, p.id, p.account, p.entity, p.entity_guid, p.capture_key, p.payload_sha256,
    p.payload::text as body, p.superseded_by, p.projected, p.record_key, ${mapped("p", "account")} as mapped, exists(
    select from public.external_records r
    where r.provider = 'toast' and r.business_id = p.business_id and r.entity = p.entity and r.id <> p.id
      and (r.source_account = p.account::text and r.source_key = p.record_key
        or (not p.projected and (r.restaurant_guid, r.entity_guid) = (p.account, p.entity_guid)))
  ) as conflict
  from scoped p order by p.id`;

// Check all candidates, including unscoped rows. An existing explicit ID must
// match exactly. A stock GUID identifies the same inventory item across observation
// dates. Other inferred links require the original date as well as a unique match.
const stock = "stock/v1/inventory";
const changes = lock => `
  with page as materialized (
    select business_id, id, restaurant_guid, entity, entity_guid, business_date,
      record_id, source_key, changes::text as body
    from public.external_record_changes
    where provider = 'toast' and source_account is null and ($1::bigint is null or id > $1)
    order by id limit $2${lock}
  )
  select p.*, ${mapped("p")} as mapped, matches.records
  from page p left join lateral (
    select jsonb_agg(candidate) as records from (
      select r.id, r.source_key, r.source_account, r.reader_owner_user_id
      from public.external_records r
      where r.provider = 'toast'
        and (r.business_id, r.restaurant_guid, r.entity) = (p.business_id, p.restaurant_guid, p.entity)
        and r.id = p.record_id
      union all
      select r.id, r.source_key, r.source_account, r.reader_owner_user_id
      from public.external_records r
      where r.provider = 'toast'
        and (r.business_id, r.restaurant_guid, r.entity) = (p.business_id, p.restaurant_guid, p.entity)
        and p.record_id is null and r.entity_guid = p.entity_guid
        and (p.entity = '${stock}' or r.business_date is not distinct from p.business_date)
      limit 2
    ) candidate
  ) matches on true order by p.id`;

function assessRecord(row) {
  if (!row.mapped) return "unverified";
  if (row.conflict || row.superseded_by || !row.record_key || !safePayload(row.record_key)) return "unresolved";
  const body = parseExactJson(row.body);
  if (!row.projected && (row.entity !== "order" || typeof body?.guid !== "string" ||
      !guid.test(body.guid) || body.guid.toLowerCase() !== row.entity_guid)) return "unresolved";
  return safePayload(body) ? "eligible" : "retention";
}

function assessChange(row, proposed) {
  if (!row.mapped) return "unverified";
  if (row.records?.length !== 1) return "unresolved";
  const candidate = row.records[0];
  const record = proposed.get(candidate.id) ?? candidate;
  if (record.source_account !== row.restaurant_guid || !record.source_key ||
      (row.source_key !== null && row.source_key !== record.source_key) ||
      (row.record_id === null && row.entity === stock && record.source_key !== row.entity_guid) ||
      !safePayload(record.source_key)) return "unresolved";
  const body = parseExactJson(row.body);
  if (!Array.isArray(body) || !body.length || !body.every(safeChange)) return "retention";
  row.match = record;
  return "eligible";
}

const sha256 = body => createHash("sha256").update(body).digest("hex");

async function saveRecords(db, rows) {
  const {rows: [result]} = await db.query(`
    select count(*)::int as saved from (
      select public.external_adopt_historical_record(r.business_id, r.provider, r.id, a.payload_sha256,
        r.payload, a.account::text, a.record_key, a.projected) as saved
      from jsonb_to_recordset($1) a(business_id uuid, id uuid, account uuid, payload_sha256 text,
        record_key text, projected boolean, body_hash text)
      join public.external_records r on r.provider = 'toast' and (r.business_id, r.id) = (a.business_id, a.id)
      where r.superseded_by is null and sha256(convert_to(r.payload::text, 'UTF8')) = decode(a.body_hash, 'hex')
        and a.account = coalesce(r.restaurant_guid, ${voidAccount("r")})
        and exists (select from public.toast_location_mappings m
          where (m.business_id, m.restaurant_guid) = (a.business_id, a.account) and m.verified_at is not null)
        and not exists (
          select from public.external_records other
          where other.provider = 'toast' and other.business_id = r.business_id and other.entity = r.entity
            and other.id <> r.id and (other.source_account = a.account::text and other.source_key = a.record_key
              or (not a.projected and (other.restaurant_guid, other.entity_guid) = (a.account, r.entity_guid)))
        )
    ) result where saved`, [JSON.stringify(rows.map(({business_id, id, account, payload_sha256, record_key, projected, body}) =>
      ({business_id, id, account, payload_sha256, record_key, projected, body_hash: sha256(body)})))]);
  return result.saved;
}

async function saveChanges(db, rows) {
  const result = await db.query(`
    update public.external_record_changes c
      set source_account = r.source_account, source_key = r.source_key, record_id = r.id,
          reader_owner_user_id = r.reader_owner_user_id, delta_origin = case
            when r.payload_origin = 'historical_projection' or r.capture_key like 'stage:%' then 'historical_projection'
            else 'historical_provider' end
    from jsonb_to_recordset($1) a(business_id uuid, id bigint, payload_hash text, matched_id uuid, matched_key text)
    join public.external_records r on r.provider = 'toast' and (r.business_id, r.id) = (a.business_id, a.matched_id)
    where c.provider = 'toast' and (c.business_id, c.id) = (a.business_id, a.id)
      and c.source_account is null and sha256(convert_to(c.changes::text, 'UTF8')) = decode(a.payload_hash, 'hex')
      and (r.restaurant_guid, r.entity, r.source_account, r.source_key) =
          (c.restaurant_guid, c.entity, c.restaurant_guid::text, a.matched_key)
      and (c.source_key is null or c.source_key = a.matched_key) and ${mapped("c")}
      and (c.record_id = r.id or (c.record_id is null and r.entity_guid = c.entity_guid
        and (case when c.entity = '${stock}' then r.source_key = c.entity_guid::text
            else r.business_date is not distinct from c.business_date end) and not exists(
          select from public.external_records other
          where other.provider = 'toast'
            and (other.business_id, other.restaurant_guid, other.entity, other.entity_guid) =
              (c.business_id, c.restaurant_guid, c.entity, c.entity_guid)
            and (c.entity = '${stock}' or other.business_date is not distinct from c.business_date)
            and other.id <> r.id
        )))`,
  [JSON.stringify(rows.map(row => ({business_id: row.business_id, id: row.id,
    payload_hash: sha256(row.body),
    matched_id: row.match.id, matched_key: row.match.source_key})))]);
  return result.rowCount;
}

const emptyCounts = () => ({eligible: 0, adopted: 0, unverified: 0, unresolved: 0, retention: 0, changed: 0});

export async function adoptExternalHistory(db, {apply = false, batchSize = 100} = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250) {
    throw new RangeError("Batch size must be between 1 and 250");
  }
  const summary = {records: emptyCounts(), changes: emptyCounts()};
  const proposed = new Map();
  for (const [kind, query, assess, save] of [
    ["records", records, assessRecord, saveRecords],
    ["changes", changes, assessChange, saveChanges],
  ]) {
    let last = null;
    for (;;) {
      await db.query(apply ? "begin" : "begin read only");
      try {
        await db.query("set local lock_timeout = '5s'");
        await db.query("set local statement_timeout = '20s'");
        const {rows} = await db.query(query(apply ? " for update" : ""), [last, batchSize]);
        const eligible = [];
        for (const row of rows) {
          const outcome = assess(row, proposed);
          if (outcome !== "eligible") {
            summary[kind][outcome]++;
            continue;
          }
          eligible.push(row);
          if (!apply && kind === "records") {
            proposed.set(row.id, {id: row.id, source_account: row.account, source_key: row.record_key});
          }
        }
        if (apply && eligible.length) {
          const saved = await save(db, eligible);
          summary[kind].adopted += saved;
          summary[kind].changed += eligible.length - saved;
        } else {
          summary[kind].eligible += eligible.length;
        }
        await db.query("commit");
        if (rows.length < batchSize) break;
        last = rows.at(-1).id;
      } catch (error) {
        await db.query("rollback").catch(() => {});
        throw error;
      }
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--apply") || !process.env.SUPABASE_DB_URL) {
    throw new Error("Set SUPABASE_DB_URL and run with no arguments for an assessment or --apply to write");
  }
  const db = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    application_name: "external_history_attribution",
  });
  try {
    await db.connect();
    console.log(JSON.stringify(await adoptExternalHistory(db, {apply: args[0] === "--apply"})));
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // PG errors may contain provider data, so only emit the error classification.
    console.error("External history attribution failed", error.code ?? error.name);
    process.exitCode = 1;
  });
}
