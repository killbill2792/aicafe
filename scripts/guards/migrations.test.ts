import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./migrations.mjs", import.meta.url));
const migrationDir = "supabase/migrations";
const existing = "20261104000153_existing.sql";
const earlier = "20261104000152_earlier.sql";
const later = "20261105143000_new.sql";
const workingDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(cwd: string, name: string, content: string | null) {
  const path = join(cwd, migrationDir, name);
  if (content === null) {
    unlinkSync(path);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function fixture(changes: Record<string, string | null>, before: Record<string, string> = { [existing]: "select 1;\n" }) {
  const cwd = mkdtempSync(join(tmpdir(), "cafe-migration-guard-"));
  workingDirectories.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(before)) write(cwd, name, content);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=test@example.invalid", "-c", "user.name=Guard Test", "commit", "-qm", "base", "--allow-empty");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "-qc", "feature");
  for (const [name, content] of Object.entries(changes)) write(cwd, name, content);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=test@example.invalid", "-c", "user.name=Guard Test", "commit", "-qm", "head", "--allow-empty");
  return { cwd, base, head: git(cwd, "rev-parse", "HEAD") };
}

function check(
  repo: ReturnType<typeof fixture>,
  labels = "",
  includeSha = true,
) {
  const env = { ...process.env, BASE_SHA: includeSha ? repo.base : "", HEAD_SHA: includeSha ? repo.head : "", PR_LABELS: labels };
  return spawnSync(process.execPath, [script], { cwd: repo.cwd, env, encoding: "utf8" });
}

afterEach(() => {
  for (const cwd of workingDirectories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("migration guard (real git trees and standalone node CLI)", () => {
  it("accepts a new, valid UTC timestamp higher than main and ignores unrelated files", () => {
    const repo = fixture({ [later]: "select 2;\n" });
    const result = check(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Migration guard passed");
  });

  it.each([
    ["20261105143000_Bad.sql", "must be named"],
    ["20261105143000_new.txt", "must be named"],
    ["20261105143000-new.sql", "must be named"],
    ["20261105256099_invalid.sql", "not a valid UTC timestamp"],
  ])("rejects invalid new filename %s", (name, diagnostic) => {
    const repo = fixture({ [name]: "select 2;\n" });
    const result = check(repo);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${migrationDir}/${name}:1: `);
    expect(result.stderr).toContain(diagnostic);
  });

  it("rejects a new number lower than the latest base number", () => {
    const repo = fixture({ [earlier]: "select 2;\n" });
    const result = check(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${migrationDir}/${earlier}:1: New migration number`);
    expect(result.stderr).toContain("must be higher than newest base number 20261104000153");
  });

  it("rejects the same number as a base migration, even with a different suffix", () => {
    const name = "20261104000153_second.sql";
    const result = check(fixture({ [name]: "select 2;\n" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be higher than newest base number");
    expect(result.stderr).toContain("Migration number 20261104000153 is also used by");
  });

  it("rejects two new migrations sharing a timestamp", () => {
    const a = "20261105143000_first.sql";
    const b = "20261105143000_second.sql";
    const result = check(fixture({ [a]: "select 2;\n", [b]: "select 3;\n" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${migrationDir}/${a}:1: Migration number 20261105143000 is also used by`);
    expect(result.stderr).toContain(`${migrationDir}/${b}:1: Migration number 20261105143000 is also used by`);
  });

  it("blocks editing an existing base migration", () => {
    const result = check(fixture({ [existing]: "select 99;\n" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${migrationDir}/${existing}:1: Existing migration was edited`);
  });

  it("blocks deleting an existing base migration", () => {
    const result = check(fixture({ [existing]: null }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${migrationDir}/${existing}:1: Existing migration was deleted`);
  });

  it.each(["migration-edit-ok", "bugfix,migration-edit-ok", '["bugfix","migration-edit-ok"]', '[{"name":"migration-edit-ok"}]'])(
    "allows an edited or deleted base migration under the exact approval label (%s)",
    (labels) => {
      const repo = fixture({ [existing]: "select 99;\n", [earlier]: null }, {
        [existing]: "select 1;\n", [earlier]: "select 2;\n",
      });
      const result = check(repo, labels);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    },
  );

  it("does not confuse similarly named labels with migration-edit-ok", () => {
    const result = check(fixture({ [existing]: null }), "not-migration-edit-ok");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Existing migration was deleted");
  });

  it("the edit label does not bypass checks for new migration names or numbers", () => {
    const name = "20261103000100_BAD.sql";
    const result = check(fixture({ [name]: "select 2;\n" }), "migration-edit-ok");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${migrationDir}/${name}:1: New migration must be named`);
  });

  it("runs without SHA environment variables from a local feature branch", () => {
    const repo = fixture({ [later]: "select 2;\n" });
    const result = check(repo, "", false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Migration guard passed");
  });
});
