#!/usr/bin/env node
/**
 * POS0f incremental preflight: enumerate the pinned official source contract
 * without treating an official schema or diagnostic capture as live coverage.
 * This is NOT the final field-level acceptance gate. That gate must execute
 * provider-shaped storage, migrated SQL, registered Supervisor and screen proof.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

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
        assert.match(response.status, /^2\\d\\d$/);
        for (const field of response.fields) {
          assert.equal(field.length, 4, "Field provenance must retain path/type/format/nullability");
          const id = JSON.stringify([family.family, operation.path, response.status, field[0]]);
          assert.ok(!identifiers.has(id), `Duplicate official source field ${id}`);
          identifiers.add(id);
          fields.push({family: family.family, operation: operation.path, status: response.status,
            fieldPath: field[0], contract, proof: snapshot.official_field_resolution.per_cafe_field_defaults});
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
