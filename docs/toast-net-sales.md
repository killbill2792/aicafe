# Toast net sales — PR 1

Canonical amounts are integer cents, not floating-point dollars. For each non-deleted, non-voided, non-test, non-excess-food order, include every check that is neither deleted nor voided, including OPEN and PAID checks.

* **Net before refunds:** sum of check \`amount\`, less deferred selections and HOUSE_ACCOUNT_PAY_BALANCE selections and FUNDRAISING_CAMPAIGN charges. Toast check amounts already include ordinary service charges and discounts, and exclude tax and gratuity.
* **Net sales:** net before refunds less \`payment.refund.refundAmount\` for non-voided/non-denied payments. Negative net is permitted.
* **Gross sales:** net before refunds plus recorded discounts; non-tax discounts are used for tax-inclusive selections.
* **Tips:** eligible payment tips less their \`tipRefundAmount\`; gratuity service charges are tracked separately. Tax and ordinary service charges remain separate reported metrics.
* **Lines:** selection net = price minus item-level refund amount; voided lines have zero net. Payment-level refunds are never subtracted twice.
* **Dates:** use \`Order.businessDate\` first. If absent or invalid, calculate from \`openedDate\` in the location's Toast IANA timezone, with the closeout-hour boundary. Payment-refund date is additionally preserved for future reconciliation.

## Void data and coverage

Void facts capture each selection on a non-deleted, non-test, non-excess-food voided selection/check/order. Prefer \`preDiscountPrice\`, then \`price\`, then quantity × \`receiptLinePrice\` (less included tax), tracking \`amount_basis\`. If all amount inputs are absent, record \`amount_missing\`; do **not** turn missing values into zero. Use \`voidBusinessDate\` for attribution, retaining the originating order date.

**Void coverage remains unknown in PR 1.** A successful import alone cannot prove a void history is complete: PR 2 must verify the late-edit re-pull and reconciliation, and ensure no unparsed orders or missing amounts, before setting any day to \`complete\`. CSV and Square never prove Toast void completeness. \`order.server\` is not the voiding actor, so \`voided_by\` remains null.

## Run lifecycle

Run creation/scheduling and automatic Analytics reconciliation belong to PR 2. This PR adds the importer callable with an explicit service-role run ID; it stages each page durably, deduplicates by GUID/modified timestamp, and calls an atomic day RPC. Keep all Toast activation flags off until the migration, reader and rollup coverage paths are validated in SQL integration testing.

Reference: https://doc.toasttab.com/doc/devguide/apiOrdersNetSalesCalculation.html
