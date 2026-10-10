# Supervisor follow-up: product sales, monthly expenses, dictation clarity

This change fixes three owner-reported confusing behaviors. **No existing money
formulas, POS data or owner permissions are changed.**

## Questions and expected answers

- "How many products am I selling so far?" routes to **unit_sales**. Uses the
  existing owner/café-scoped `menu_item_quantities_sold` RPC for dated, mapped
  menu-product quantities; separately reports trusted `daily_rollups` drink and
  order counts. All three are typed **counts**, not dollar amounts. Does not
  silently treat orders as units sold. If product lines aren't available,
  reports only drink/order counts with an explicit itemization warning. If
  sales rollups are missing days, counts are explicitly labeled as
  **recorded days only**; no missing-day zeroes are invented. An uploaded file
  does not automatically become verified sales.
- "What are my monthly bills?" uses exactly the active recurring-cost rows and
  frequency-to-month conversion used on the **Bills page**, not a prorated
  allocation of the first calendar days. This is a **full-month recurring
  budget**, not proof the bills have been paid.
- "What are my total expenses for the month?" explains the difference between
  that full recurring-bills budget and **month-to-date operating costs** from
  the already canonical period profitability engine. If full business-cost
  evidence is incomplete, keeps the monthly bills answer and marks the total
  costs **unavailable**, not zero.
- "How much have I actually spent this month?" reads real `expenses` rows
  marked actual from the same café. Labels that partial ledger subset clearly:
  no implicit inclusion of staff, card fees, sales-based ingredient costs or
  unentered cash spending.
- "How much of my recurring costs have accrued?" still uses the existing
  calendar-day proration in `lib/calc/runningCosts.ts`.

## Voice interaction

In supported browsers, the mic button now **changes appearance** to a pulsing
red listening state with Stop label and accessible pressed state. Live interim
speech is shown below the input. Stopping enters a visible "Finishing
transcript…" state; confirmed text appears in the editable input, with a
"Review before sending" cue. Nothing is submitted automatically. Start,
microphone permission errors, unsupported recognition, and no speech each have
a dedicated visible outcome. Dictation uses the browser provider, not an
AI CAFE audio-recording backend; some devices will not support it.

## Security and limitations

- All data is read only and café bound by the existing authenticated tool
  factory and Supabase RLS. The server query's business ID never comes from
  the chat text. The owner must still press Send.
- Counts have a separate schema block with integer/nonnegative validation
  and exactly cited evidence, preventing a quantity from being formatted as
  dollars.
- Itemized POS quantity is only as complete as mapped sales rows; a partial
  import cannot be described as a complete café-wide sold-product tally.
- English, Spanish, Arabic strings updated. No new SQL migrations or
  provider credentials needed. There is no freeform AI model in this reply
  router; supported intents are deterministic and evidence sourced.
