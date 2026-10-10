# Phase 6 — microphone and private reference uploads

Uses browser speech recognition when supported. Owner's full transcript appears
in the existing editable Home composer, **never automatically sent**.
On unsupported browsers, typing remains available. Browser speech APIs can
send audio to browser provider services: don't promise offline processing.

Private file upload: PDF, PNG, JPEG, WebP, or UTF-8 plain text, maximum 2 MiB.
The server verifies signature and size, checks authenticated owner/thread,
uploads to private Supabase Storage bucket, and inserts one owner/café/thread
scoped immutable `ai_attachments` metadata row. The UI lists private names.
Files are **stored but not analysed**. They do not alter ingredient prices,
receipts, inventory, POS, profit, or reply evidence. There is NO OCR integration
or audio server recording in this phase, and no fake extraction.

Migration 35 adds the private storage bucket and RLS metadata, with
owner-only Storage path policies. Apply *after* reviewing/reconciling migrations
33 and 34 (Phase 5 PR #37 was merged during this task). Test real Storage RLS
using two café owners and a manager; SQL smoke tests complement but do not replace
live authenticated Supabase staging checks. Never blindly `supabase db push`.

Activation: existing `SUPERVISOR_CHAT_ENABLED=true` plus existing Phase 3
schema, valid Supabase storage and service-role configured. No extra provider
credentials needed; browser transcription availability depends on device.
