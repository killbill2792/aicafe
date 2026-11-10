#!/usr/bin/env node
/**
 * POS0f incremental preflight: enumerate the pinned official source contract
 * without treating an official schema or diagnostic capture as live coverage.
 * This is NOT the final field-level acceptance gate. That gate must execute
 * provider-shaped storage, migrated SQL, registered Supervisor and screen proof.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const sameOrChild = (field, prefix) => field === prefix ||
  field.startsWith(prefix + ".") || field.startsWith(prefix + "[");
const exceptionFor = (manifest, family, operation, fieldPath) =>
  manifest.official_field_resolution.field_prefix_exceptions
    .filter(row => row.family === family && row.operation_path === operation &&
      sameOrChild(fieldPath, row.field_prefix))
    .sort((a, b) => b.field_prefix.length - a.field_prefix.length)[0] ?? null;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "docs/plans/toast-openapi-spec-snapshot.json"), "utf8"));

export function officialFieldInventory(snapshot = manifest) {
  const families = snapshot.official_snapshot.families;
  const contracts = new Map(snapshot.official_field_resolution.family_contracts.map(row => [row.family, row]));
  assert.equal(contracts.size, families.length, "Each official family must have one source-to-consumer contract");
  const fields = [];
  const identifiers = new Set();
  for (const family of families) {
    const contract = contracts.get(family.family);
    assert.ok(contract, `Missing official source contract: ${family.family}`);
    for (const operation of family.operations) {
      assert.equal(operation.method, "GET", "Only permitted read-operation definitions belong in this inventory");
      for (const response of operation.responses) {
        assert.match(response.status, /^2\d\d$/);
        for (const field of response.fields) {
          assert.equal(field.length, 4, "Field provenance must retain path/type/format/nullability");
          const id = JSON.stringify([family.family, operation.path, response.status, field]);
          assert.ok(!identifiers.has(id), `Duplicate official field definition ${id}`);
          identifiers.add(id);
          const exception = exceptionFor(snapshot, family.family, operation.path, field[0]);
          fields.push({
            family: family.family, operation: operation.path, status: response.status,
            fieldPath: field[0], fieldType: field[1], fieldFormat: field[2],
            nullMarker: field[3],
            contract, exception, proof: snapshot.official_field_resolution.per_cafe_field_defaults,
          });
        }
      }
    }
  }
  return fields;
}

test("POS0f official field inventory is derived from every pinned response, never a fixed endpoint total", () => {
  const fields = officialFieldInventory();
  assert.ok(fields.length > 0, "An empty manifest cannot pass");
  assert.equal(fields.length, manifest.official_snapshot.nested_response_field_rows);
  assert.ok(fields.every(row => row.contract && row.proof), "All fields inherit explicit provenance and missing-proof status");
});

test("POS0f preflight cannot mistake official documentation or old diagnostic captures for execution evidence", () => {
  const fields = officialFieldInventory();
  for (const row of fields) {
    assert.equal(row.proof.grant, "not_tested", "A schema alone is not a café credential grant");
    assert.equal(row.proof.response, "not_tested", "A schema alone is not a provider response");
    assert.equal(row.proof.field_queryable, "not_verified", "A schema alone is not a working query_data retrieval");
    assert.equal(row.proof.registered_supervisor_and_screen, "not_verified",
      "A schema alone is not registered Supervisor + screen parity");
  }
  assert.notEqual(manifest.historical_redacted_diagnostic.classification, "OPERATIONAL_CURRENT");
});

/** This ledger intentionally reports *missing* live evidence, never an implicit PASS.
 * CI publishes it as a machine-readable artifact for matching future per-field
 * executed source/writer/reader receipts without hardcoding operation counts. */
export function officialFieldCoverageLedger(snapshot = manifest) {
  const fields = officialFieldInventory(snapshot);
  const rows = fields.map(row => ({
    family: row.family,
    operation: row.operation,
    response_status: row.status,
    source_field: row.fieldPath,
    field_type: row.fieldType,
    field_format: row.fieldFormat,
    null_marker: row.nullMarker,
    required_scope: row.exception?.additional_or_required_scope ?? row.contract.source_scope,
    object_identity: row.contract.object_identity,
    current_writer: row.contract.current_writer_storage,
    current_reader: row.contract.current_operational_reader,
    supervisor_reader: row.contract.supervisor_reader,
    screen_consumer: row.contract.screen_consumer,
    responsible_owner: row.contract.downstream_owner,
    privacy_classification: row.exception?.privacy_override ??
      snapshot.official_field_resolution.privacy_default,
    known_gap: row.exception?.field_gap ?? row.contract.known_gap,
    status: {...row.proof},
    last_verified_date: null,
    executed_source_to_supervisor_proof: null,
  }));
  const perFamily = Object.fromEntries(snapshot.official_snapshot.families.map(f => [
    f.family, {operations: f.operations.length, fields: rows.filter(row => row.family === f.family).length,
      observed_cafe_fields: 0, supervisor_screen_verified_fields: 0},
  ]));
  return {
    classification: "PINNED_SCHEMA_AND_UNVERIFIED_CAFE_FIELD_GAPS__NOT_ACCEPTANCE",
    official_as_of_utc: snapshot.as_of_utc,
    official_source_run: snapshot.official_snapshot.source_run,
    total_official_nested_field_rows: rows.length,
    per_family: perFamily,
    fields: rows,
  };
}

test("POS0f generated field ledger retains type, privacy/entitlement exceptions and all unverified source→consumer steps", () => {
  const ledger = officialFieldCoverageLedger();
  assert.equal(ledger.total_official_nested_field_rows, manifest.official_snapshot.nested_response_field_rows);
  assert.equal(Object.values(ledger.per_family).reduce((sum, f) => sum + f.fields, 0), ledger.fields.length);
  assert.ok(ledger.fields.every(row => row.current_writer && row.current_reader &&
    row.supervisor_reader && row.screen_consumer && row.privacy_classification &&
    row.last_verified_date === null && row.executed_source_to_supervisor_proof === null &&
    row.status.grant === "not_tested" && row.status.field_queryable === "not_verified"));
  for (const exception of manifest.official_field_resolution.field_prefix_exceptions) {
    const matching = ledger.fields.filter(row => row.family === exception.family &&
      row.operation === exception.operation_path &&
      sameOrChild(row.source_field, exception.field_prefix));
    assert.ok(matching.length > 0, "Unmatched source-scoped field exception " +
      JSON.stringify([exception.family, exception.operation_path, exception.field_prefix]));
    const exact = ledger.fields.find(row => row.family === exception.family &&
      row.operation === exception.operation_path && row.source_field === exception.field_prefix);
    if (exact) assert.equal(exact.privacy_classification, exception.privacy_override);
  }
  if (process.env.POS0F_FIELD_MATRIX_PATH) {
    writeFileSync(process.env.POS0F_FIELD_MATRIX_PATH, JSON.stringify(ledger, null, 2) + "\n");
  }
});
