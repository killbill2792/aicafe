---
name: postgres
description: PostgreSQL best practices, query optimization, connection troubleshooting, and performance improvement. Load when working with Postgres databases.
license: MIT
metadata:
  author: planetscale
  version: "1.0.0"
---

> **AI Cafe local rules (added by AI Cafe; they override the upstream text below).**
> - **Supabase skill rules win on any conflict** (`supabase`, `supabase-postgres-best-practices`, and AGENTS.md: RLS on every table, `security_invoker` views, integer cents).
> - Use it for index audits, query patterns, partitioning and EXPLAIN-driven tuning of our analytics queries and views, on the local database or a copy. Never run tuning SQL, `VACUUM FULL`, index drops or config changes on the live project; ship changes as migration files.
> - Removed upstream: the "Hosting: PlanetScale" paragraph and all `references/ps-*.md` files. Links now point to local files. PgBouncer/Postgres server settings are managed by Supabase; read them as background only.
> - Source, pinned commit and local changes: [SOURCE.md](SOURCE.md). Index: `docs/rules/skills.md`. AGENTS.md wins over this skill.

# PlanetScale Postgres

## Generic Postgres

| Topic                  | Reference                                                        | Use for                                                   |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Schema Design          | [references/schema-design.md](references/schema-design.md)           | Tables, primary keys, data types, foreign keys            |
| Indexing               | [references/indexing.md](references/indexing.md)                      | Index types, composite indexes, performance               |
| Index Optimization     | [references/index-optimization.md](references/index-optimization.md) | Unused/duplicate index queries, index audit               |
| Partitioning           | [references/partitioning.md](references/partitioning.md)             | Large tables, time-series, data retention                 |
| Query Patterns         | [references/query-patterns.md](references/query-patterns.md)         | SQL anti-patterns, JOINs, pagination, batch queries       |
| Optimization Checklist | [references/optimization-checklist.md](references/optimization-checklist.md) | Pre-optimization audit, cleanup, readiness checks  |
| MVCC and VACUUM        | [references/mvcc-vacuum.md](references/mvcc-vacuum.md)               | Dead tuples, long transactions, xid wraparound prevention |

## Operations and Architecture

| Topic                  | Reference                                                                    | Use for                                                         |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Process Architecture   | [references/process-architecture.md](references/process-architecture.md)     | Multi-process model, connection pooling, auxiliary processes     |
| Memory Architecture    | [references/memory-management-ops.md](references/memory-management-ops.md)   | Shared/private memory layout, OS page cache, OOM prevention     |
| MVCC Transactions      | [references/mvcc-transactions.md](references/mvcc-transactions.md)           | Isolation levels, XID wraparound, serialization errors          |
| WAL and Checkpoints    | [references/wal-operations.md](references/wal-operations.md)                 | WAL internals, checkpoint tuning, durability, crash recovery    |
| Replication            | [references/replication.md](references/replication.md)                       | Streaming replication, slots, sync commit, failover             |
| Storage Layout         | [references/storage-layout.md](references/storage-layout.md)                | PGDATA structure, TOAST, fillfactor, tablespaces, disk mgmt     |
| Monitoring             | [references/monitoring.md](references/monitoring.md)                         | pg_stat views, logging, pg_stat_statements, host metrics        |
| Backup and Recovery    | [references/backup-recovery.md](references/backup-recovery.md)              | pg_dump, pg_basebackup, PITR, WAL archiving, backup tools      |

## Connection pooling (PgBouncer)

| Topic              | Reference                                                                    | Use for                                               |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| PgBouncer Config   | [references/pgbouncer-configuration.md](references/pgbouncer-configuration.md) | default_pool_size, max_user_connections, pool limits  |
