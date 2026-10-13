# Dependent Toast order-event stage worker (draft PR)

Migration 49 adds a per-tenant per-order sanitized staging table, persists only a stable order GUID alongside the signed webhook event, and provides a bounded lease-based event claim/finish pair protected for service-role-only execution. Database-row locks and random lease nonces make retries idempotent and prevent an older worker from completing a newer claim.

POST /api/pos/toast/jobs/orders has a required server-only TOAST_JOB_SECRET and a separate TOAST_JOBS_ENABLED=false-by-default gate. It handles at most two events per request and uses one authenticated Toast orders GET per event. A normalized completed order is staged; an open, deleted or ambiguous result is marked review_required without affecting sales totals. No customer, card or unfiltered webhook body is stored.

This is scheduler-callable, NOT automatically scheduled and NOT a continuous live sales feed. It never mutates canonical orders or daily rollups. No Vercel cron change, no Supervisor messages, no QuickBooks/inventory work. Still needed: missed-webhook safety polling, labor polling, full source overlap and historical refund-day settlement, official live testing, multi-location coverage and disabled pilot activation approval.

Apply migration 49 only after migrations 40-48 have been reviewed and applied to an isolated staging database. No production migrations have been run.
