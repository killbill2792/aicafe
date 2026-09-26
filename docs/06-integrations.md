# 06 — Integrations

## Square (v1, OAuth, read-only)
- Create an app in the Square Developer Dashboard. Use **sandbox** for development, production for the pilot.
- OAuth code flow from S2 step 1. Store tokens encrypted in `pos_connections`. Refresh before expiry (job).
- Scopes (request only these): `MERCHANT_PROFILE_READ`, `ORDERS_READ`, `PAYMENTS_READ`, `ITEMS_READ`, `EMPLOYEES_READ`, `TIMECARDS_READ`, `TIMECARDS_SETTINGS_READ`. Add `CUSTOMERS_READ` only when a feature needs it.
- Confirm current scope names and endpoints in Square's docs before coding; Square renamed its Labor "Shift" objects to **Timecards** (API version 2025-05-21 or later). Use the Timecard endpoints.

Sync
1. **Backfill** on connect: last 90 days of orders (SearchOrders by location, closed state), payments (for processing fees), catalog (items, variations, modifiers), team members, timecards. Show progress: "Getting your last 3 months… 40%".
2. **Incremental**: webhooks for order and payment updates and timecard changes → enqueue a sync for that record. Plus a safety poll every 10 minutes during open hours (covers missed webhooks).
3. After each sync, recompute `daily_rollups` for affected business dates, then alerts.
- Map fields: order net sales = total − tax − tips (use Square's money fields; verify against the Sales Summary report for one day during testing).
- Processing fee: sum of `processing_fee` amounts on payments linked to the order.
- Voids and comps: from order line states/discounts; store on `order_lines`.
- Handle 429/5xx with exponential backoff. Idempotent upserts on `(business_id, pos_*_id)`.
- Test checklist: one day's totals in our app must match Square's Sales Summary (net sales, fees) and Labor report (hours) to the cent/minute.

## Toast and other POS (v1 = CSV upload)
- Toast API needs partner approval or the restaurant's own read-only API credentials (requires a qualifying Toast plan). Not in v1.
- v1: owner (or you, with them) exports CSVs from Toast Web: **Sales summary / product mix** (item sales by day) and **Labor time entries**. Upload in More → Uploads.
- Build a generic **CSV column mapper**: first upload shows detected columns → owner/you map them (date, item, quantity, net sales, fees; or employee, clock in, clock out, wage). Save the mapping per business so later uploads are one tap.
- Writes into the same `orders`/`order_lines`/`timecards` tables with `provider = 'csv'` (one synthetic order per item per day is fine).

## Bank statements (v1)
Input: CSV (preferred) or PDF, downloaded by the owner from their bank. Max 10 MB.
1. Store the file in Supabase Storage (private bucket, per business folder). Create an `uploads` row.
2. Parse:
   - CSV: detect date, description, amount (or debit/credit) columns; handle common US bank formats; negative = money out.
   - PDF: extract text (`pdf-parse`), then send pages to the AI with the schema below to get lines. If the PDF is scanned (no text), send page images to a vision model.
3. **Balance check** when the statement shows opening/closing balances: opening + Σ lines = closing. Show ✓ or "Some lines may be missing. Please check."
4. Keep only money-out lines. Skip transfers between own accounts, owner draws, card payments to own credit card (ask once, remember via `vendor_rules`), and POS payout deposits.
5. Categorize in this order: `vendor_rules` (learned) → keyword rules (PG&E → utilities_power, EBMUD → water, Comcast/AT&T → internet, Safeway/Costco/Restaurant Depot → supplies, landlord name entered in onboarding → rent) → AI for the rest.
6. Dedupe with `dedupe_key` against existing expenses (a receipt photo and its bank line are the same purchase: keep the receipt, mark the bank line as matched).
7. Review screen: grouped by category, each line with its reason and confidence. Low confidence (< 0.7) is highlighted. "Save all" writes `expenses` with `source = 'statement'`, `status = 'actual'`. Owner corrections write `vendor_rules`.

## Receipt photos (v1)
Camera capture (`<input type="file" accept="image/*" capture="environment">`) → compress to ≤ 1600px JPEG → vision model with the schema below → review card → save `expenses` + `expense_lines`. Map lines to ingredients when the owner confirms ("Whole milk × 4 gal" → Whole milk), then add an `ingredient_prices` row.

## Voice entry (v1)
Hold-to-talk. Use the browser's speech recognition where available; otherwise record audio and send it to the AI provider's transcription endpoint. Then parse the transcript with the "voice expense" prompt. Always show a confirm card.

## AI prompts (structured JSON only)
Wrapper: `lib/ai/complete(task, input)` → validates output with zod, retries once on invalid JSON, logs token usage (not content).
Use the provider's cheapest capable model. Temperature 0.

**Statement line categorizing**
```
System: You categorize business bank transactions for an independent café in the US.
Return ONLY JSON: {"lines":[{"i":number,"category":one of [rent,utilities_power,water,internet,insurance,loan,software,supplies,repairs,ingredients,other,exclude],"vendor":string,"reason":string (max 12 words, plain English),"confidence":0..1}]}
Use "exclude" for transfers between the owner's accounts, owner withdrawals, credit card payments, tax payments, and deposits.
User: Café context: {landlord name, known vendors}. Lines: [{"i":0,"date":"2026-09-02","description":"PGANDE WEB ONLINE","amount":-412.33}, ...]
```

**Receipt reading**
```
System: Read this store receipt. Return ONLY JSON:
{"vendor":string,"date":"YYYY-MM-DD","total_cents":int,"tax_cents":int,"lines":[{"description":string,"quantity":number|null,"unit":string|null,"amount_cents":int,"likely_ingredient":one of [milk,oat_milk,espresso_beans,cups,lids,syrup,pastry,cleaning,other]}],"suggested_category":string}
If a value is unreadable, use null. Line amounts must add up to total minus tax; if they don't, still return what you read.
```

**Voice expense**
```
System: Extract one business expense from what a café owner said. Return ONLY JSON:
{"amount_cents":int,"category":string,"vendor":string|null,"date":"YYYY-MM-DD" (default today {today}),"is_recurring_monthly":boolean}
```

## Messaging (v1.5)
Weekly summary by SMS (Twilio) or WhatsApp Business API. Opt-in per user with a phone number. Content = top 3 money items + link to the app.

## Security
- Tokens and secrets only on the server (route handlers / edge functions). Never in the client bundle.
- Encrypt POS tokens (AES-GCM with a key in env, or Supabase Vault).
- Storage buckets private; signed URLs expire in 10 minutes.
- Don't send customer names or card data to AI. Send only what's needed.
- Delete account = delete business data, files, and revoke the Square token.
- Privacy policy and pilot agreement required before connecting a real café.
