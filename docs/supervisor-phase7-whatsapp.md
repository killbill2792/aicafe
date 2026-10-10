# Phase 7 — proactive owner Team alerts

The daily cron reads **existing persisted** `operating_tasks` only, never
recreates or changes the Needs You/Handled/Watching inbox. It sends an approved
Meta WhatsApp template for the most recent `needs_owner` task per opted-in
owner per UTC day. Sending is **default off** and requires CRON_SECRET,
AI_CAFE_WHATSAPP_ENABLED=true, META_WHATSAPP_TOKEN, META_WHATSAPP_PHONE_ID and
a Meta-approved `ai_cafe_owner_task_alert` template with one text placeholder.
Template conveys only the safe task category, never employee names, invoices,
financial amounts or customer information.

Opt-in uses the owner’s **verified Supabase Auth phone**, not a user-typed
number. Opt-out immediately disables future sends. Every external send must
first reserve a unique delivery in `ai_delivery_attempts`. A crash after the
provider accepts a message will not cause an automatic duplicate: outstanding
"reserved"/"failed" deliveries require manual inspection, not blind retry.
The provider receipt ID is recorded only on actual success.

This does not pretend WhatsApp staff messages/interactive replies are live.
Staff communication still requires verified employee opt-ins, provider
templates and a secure inbound webhook, none of which are included here.
The existing StaffCommunicationProvider fallback remains unavailable.

Migration 36 adds two tables with owner RLS and server-only delivery ledger.
Apply after 33–35; reconcile SQL history before production. Review Meta policy,
approved template and owner consent, staging RLS, quota and daily cron schedule.
No production messages were sent by this implementation.
