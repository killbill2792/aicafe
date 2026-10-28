# Canonical café data dictionary

Each row is café-scoped and source-tagged. The view uses invoker RLS; no raw card, guest or credential payload is exposed.

## cv_sales_days

Daily shared café sales rollups

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| net_sales_cents | Recorded net sales in integer cents. | cents | app | How much did we sell yesterday? |
| orders_count | Number of recorded orders. | count | app | How many orders yesterday? |

## cv_sales_hours

Hourly recorded sales

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| net_sales_cents | Recorded net sales in integer cents. | cents | app | How much did we sell yesterday? |
| orders_count | Number of recorded orders. | count | app | How many orders yesterday? |

## cv_item_sales

Individual sold items

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| order_duration_seconds | Time from recorded Toast open to close; repeats on lines of the same order. | seconds | toast | How long were orders open? |
| item_taxes | Order's selection tax amounts and rates, with selection identifiers. | JSON cents/rate | toast | What tax was charged per item? |
| modifier_prices | Provider modifier prices linked to each selection; unknown prices stay null. | JSON cents | toast | What did modifiers cost? |
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| net_sales_cents | Recorded net sales in integer cents. | cents | app | How much did we sell yesterday? |
| quantity | Recorded item quantity, including fractional units. | items | app | How many sold? |

## cv_payments

Sanitized Toast payments

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| payment_type | Toast payment method (card/cash/gift), when supplied. | label | toast | How much was paid by card? |
| card_type | Card network/type from Toast, when supplied. | label | toast | What was Visa volume? |
| card_entry_mode | How the card was entered, from Toast. | label | toast | What were keyed-card fees? |
| original_processing_fee_cents | Original Toast-reported fee, not an estimate. | cents | toast | What fee did Toast report? |
| processing_fee_cents | Selected fee per payment, or null when unknown. | cents | toast | What were the processing fees? |
| fee_status | Actual, estimated or missing fee provenance. | label | toast | Which fees are estimates? |
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| amount_cents | Recorded amount, or null when unknown. | cents | app | How much was it? |
| tip_cents | Tip portion in integer cents; null when unknown. | cents | toast | What tips were paid? |

## cv_discounts

Recorded order discounts

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| check_discounts | Named check-level discounts for this order. | JSON cents | toast | Which discount names were used? |
| item_discounts | Named item-level discounts for this order. | JSON cents | toast | Which items received discounts? |
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| amount_cents | Recorded amount, or null when unknown. | cents | app | How much was it? |

## cv_voids_refunds

Toast void/refund evidence

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| provider_details | Provider-reported void/refund reasons and amounts from current committed order evidence. | JSON | toast | Why was this item voided? |
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| amount_cents | Recorded amount, or null when unknown. | cents | app | How much was it? |

## cv_card_fees

Actual or estimated card fees

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| amount_cents | Recorded amount, or null when unknown. | cents | app | How much was it? |

## cv_labor_entries

Recorded timecards

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| regular_hours | Regular hours exactly supplied by Toast; nullable. | hours | toast | What regular hours did Toast record? |
| overtime_hours | Overtime hours exactly supplied by Toast; nullable. | hours | toast | What overtime did Toast record? |
| hourly_wage_cents | Recorded hourly wage in integer cents; nullable when unknown. | cents/hour | toast | What wage did Toast supply? |
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

## cv_staff

Employee roster

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

## cv_shifts

Published application shifts

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

## cv_menu

Current catalog

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

## cv_bills

Recurring owner costs

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

## cv_inventory

App pantry counts and Toast at-risk menu item stock captured snapshots

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| menu_item_ref | Toast menu-item reference for at-risk stock snapshots; absent items are not zero. | identifier | toast | What was recorded? |
| stock_status | Toast OUT_OF_STOCK or QUANTITY status; null for app pantry rows. | label | toast | What was recorded? |
| quantity | Reported quantity when known; pantry base quantity for app rows. | quantity | toast | What was recorded? |

## cv_owner_facts

Persisted owner answers

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

## cv_analytics

Typed Toast ERA measurements

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| value_numeric | Numeric ERA measurement; money metrics use cents. | metric-dependent | toast | What did Toast report? |

## cv_orders

Order dining options, source channels and guest counts for stored café orders.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café local business date associated with the record or sample. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| order_ref | Stored order reference, not a guest identifier. | identifier | app | What was recorded? |
| dining_option | Dining option identifier or name from the order when supplied. | label | toast | What was recorded? |
| source_channel | POS-provided order channel when supplied. | label | toast | What was recorded? |
| guest_count | Number of guests reported on the order, when available. | count | toast | What was recorded? |
| net_sales_cents | Current recorded order net sales in cents; null when the order is excluded or superseded (the original amount remains in data for review). | cents | app | What were sales by channel? |

## cv_cash

Cash movements and deposits from redacted Toast diagnostics, not continuous cash sync.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café local business date associated with the record or sample. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| entry_type | Cash entry action or deposit type. | label | toast | What was recorded? |
| amount_cents | Reported cash movement amount in cents; null when missing. | cents | toast | What was recorded? |
| cash_drawer_ref | Redacted drawer identifier, if supplied. | identifier | toast | What was recorded? |
| employee_ref | Redacted employee identifier, if supplied. | identifier | toast | What was recorded? |

## cv_kitchen

Toast kitchen fulfillment and prep station diagnostic snapshots; optional KDS/Pro access.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café local business date associated with the record or sample. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| order_ref | Toast order reference from fulfillment record. | identifier | toast | What was recorded? |
| ticket_ref | Kitchen ticket reference. | identifier | toast | What was recorded? |
| fired_at | Provider ticket-fired timestamp, when recorded. | timestamp text | toast | What was recorded? |
| started_at | Provider item-start timestamp, when recorded. | timestamp text | toast | What was recorded? |
| ready_at | Provider item-fulfilled timestamp, when recorded. | timestamp text | toast | What was recorded? |
| prep_station_ref | Provider prep station reference. | identifier | toast | What was recorded? |

## cv_dining_options

Toast dining-option name configuration from optional redacted captures.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café local business date associated with the record or sample. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| dining_option_ref | Toast dining-option reference. | identifier | toast | What was recorded? |
| dining_option_name | Safe Toast dining-option label when supplied. | label | toast | What was recorded? |

## Capture-only Toast evidence and limitations

`cv_cash`, Toast rows of `cv_inventory`, `cv_kitchen` and `cv_dining_options` are derived from **redacted diagnostic snapshots** in `toast_raw_samples`; they are not continuously imported operational data. A missing capture, failed response or zero returned rows does not establish an operational zero. Repeated captures can record the same underlying event multiple times, so they must not be summed as daily totals without deduplication.

- **Cash:** `cashmgmt/v1/entries` and `cashmgmt/v1/deposits` expose cash entry/deposit amounts and identifiers. Drawer/employee names are not included in these endpoints; separately collected configuration and labor data would be needed for names.
- **Stock:** `stock/v1/inventory` returns only `OUT_OF_STOCK` or `QUANTITY` menu items. Missing items are not evidence of a zero balance or a confirmed `IN_STOCK` status.
- **Kitchen prep stations:** Configuration rows from `kitchen/v1/published/prepStations` carry `guid` and `name`, not the fulfillment-only `prepStationGuid` and `prepStationName`. These are both projected safely (migration 118).
- **Kitchen:** `kitchen/v1/export/itemFulfillments` and `kitchen/v1/published/prepStations` expose fulfillment timestamps and prep-station data where available. Item fulfillment requires eligible KDS/Toast subscription access; a 204 or no data does not mean preparation took zero time.
- **Excluded/superseded orders:** `cv_orders` retains these non-current rows with `status='needs_match'` and review flags instead of hiding them. They are available for explanation but must not be summed into current sales totals.
- **Dining options:** `config/v2/diningOptions` provides names only where captured. `cv_orders` exposes stored `orders.dining_option`, `source_channel` and `guest_count` regardless of whether the configuration endpoint is available.

The diagnostic capture is performed by `captureToastRawSample`; it is not automatically run by each day import. Daily operational copies, full Toast-report parity and durable typed cash/stock/kitchen ingestion have not yet been implemented. Apply migrations **114**, **115**, **116**, **117** and **118** manually in order after 110–113. Migration 115 grants owner-authenticated execution of the redacting label helper used by the invoker-RLS view; migration 116 preserves excluded/superseded order evidence; migration 117 exposes current order sales by channel; migration 118 preserves prep-station configuration names and identifiers. Never rewrite a previously applied migration.
