# Canonical café data dictionary

Generated from `lib/data/canonical/dictionary.ts`. Owner-only views never expose raw provider payloads.

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
| Column | Meaning | Unit | Source | Example owner question |
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
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |
| regular_hours | Regular hours exactly supplied by Toast; nullable. | hours | toast | What regular hours did Toast record? |
| overtime_hours | Overtime hours exactly supplied by Toast; nullable. | hours | toast | What overtime did Toast record? |
| hourly_wage_cents | Recorded hourly wage in integer cents; nullable when unknown. | cents/hour | toast | What wage did Toast supply? |

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

Recorded stock counts

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for the underlying fact. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Café business date when recorded; null for undated reference facts. | local date | app | What happened last week? |
| data | Restricted, non-sensitive attributes relevant to this canonical entity. | JSON | app | Show the source detail. |

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
