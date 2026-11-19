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

Imported, finalized order discount arrays for screens. One row represents an order, NOT one discount use; do not count these rows to answer how many discounts were applied today. For precise per-use counts, read cv_toast_records item_discount and check_discount, filtering counts_in_sales=true.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| check_discounts | Check-level discounts grouped inside one imported order. A discount use is each non-VOID entry, not this array or the number of checks. Excludes removed discounts. | JSON cents | toast | Which discount names were used? |
| item_discounts | Item-level discounts grouped inside one imported order. Multiple uses may belong to one order. Excludes removed discounts. | JSON cents | toast | Which items received discounts? |
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

Dated owner stock counts and one retained Toast stock object per café/restaurant/item. The latest complete family receipt determines whether Toast quantity is current; data.evidence_state identifies observed_current, not_observed, source_failed or source_unverified. A menu GUID is menu_item_ref, not source_ref. Unknown is not zero.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Stable reference for this inventory evidence row. This is NOT the Toast menu-item GUID; use menu_item_ref for a specific Toast stock item. | identifier | app | Which record supports it? |
| status | Actual, estimated, open, needs match or owner provided. | label | app | Which facts are incomplete? |
| business_date | Owner count measurement date; Toast stock with a family receipt uses the café-local query date, while legacy source rows without a receipt retain their observed business date and remain unverified. The original provider observation date and source time stay in data. | local date | app | What happened last week? |
| data | Restricted inventory evidence: source_as_of, observed_business_date, checked_at, source_status and evidence_state; never raw provider credentials or diagnostic captures. | JSON | app | Show the source detail. |
| menu_item_ref | The Toast menu-item GUID used by retained stock records. Filter menu_item_ref = the supplied Toast item GUID for a specific item; source_ref is a different evidence-row reference. An absent item is not quantity zero. | identifier | toast | What was recorded? |
| stock_status | Last authenticated Toast QUANTITY / OUT_OF_STOCK status only while the latest successful source receipt matches; null on stale, failed or missing stock. | label | toast | What was recorded? |
| quantity | Toast reported nonnegative quantity only for a current matching successful stock receipt; dated owner count (including explicit zero) otherwise. Missing or historical Toast quantities are null. | quantity | toast | What was recorded? |

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
| business_date | Café local business date of the retained current Toast record, when supplied. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| order_ref | Stored order reference, not a guest identifier. | identifier | app | What was recorded? |
| dining_option | Dining option identifier or name from the order when supplied. | label | toast | What was recorded? |
| source_channel | POS-provided order channel when supplied. | label | toast | What was recorded? |
| guest_count | Number of guests reported on the order, when available. | count | toast | What was recorded? |
| net_sales_cents | Current recorded order net sales in cents; null when the order is excluded or superseded (the original amount remains in data for review). | cents | app | What were sales by channel? |

## cv_cash

Retained current Toast cash movements and deposits, not diagnostic captures; source freshness and permissions remain unverified until the relevant live sync proves coverage.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café local business date of the retained current Toast record, when supplied. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| entry_type | Cash entry action or deposit type. | label | toast | What was recorded? |
| amount_cents | Reported cash movement amount in cents; null when missing. | cents | toast | What was recorded? |
| cash_drawer_ref | Redacted drawer identifier, if supplied. | identifier | toast | What was recorded? |
| employee_ref | Redacted employee identifier, if supplied. | identifier | toast | What was recorded? |

## cv_kitchen

Retained current Toast kitchen fulfillment and prep station facts; KDS permission and freshness must be verified.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café local business date of the retained current Toast record, when supplied. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| order_ref | Toast order reference from fulfillment record. | identifier | toast | What was recorded? |
| ticket_ref | Kitchen ticket reference. | identifier | toast | What was recorded? |
| fired_at | Provider ticket-fired timestamp, when recorded. | timestamp text | toast | What was recorded? |
| started_at | Provider item-start timestamp, when recorded. | timestamp text | toast | What was recorded? |
| ready_at | Provider item-fulfilled timestamp, when recorded. | timestamp text | toast | What was recorded? |
| prep_station_ref | Provider prep station reference. | identifier | toast | What was recorded? |

## cv_dining_options

Retained current Toast dining-option configuration, not diagnostic captures; undated reference records are included regardless of the requested café date range, without inventing a business date. Provider permissions and freshness may be incomplete.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Data origin: Toast, owner, or application. | label | app | Where did this number come from? |
| source_ref | Reference to stored evidence, not a guest identity. | identifier | app | Which record supports it? |
| status | Actual, open or incomplete; capture-only is not live POS coverage. | label | app | Is this record complete? |
| business_date | Café business date supplied by Toast; NULL for undated dining-option configuration. Reference records remain queryable for any selected date range. | local date | app | What happened on this date? |
| data | Limited non-sensitive fields; no raw POS or customer payload. | JSON | app | Show the provider detail. |
| dining_option_ref | Toast dining-option reference. | identifier | toast | What was recorded? |
| dining_option_name | Safe Toast dining-option label when supplied. | label | toast | What was recorded? |

## cv_toast_records

Count discount uses with record_type in (item_discount, check_discount) and counts_in_sales=true, grouped by data.name; count source_ref for uses, count_distinct order_ref for different orders, count_distinct check_ref for different checks. An order may have several checks and discount uses. Removed processingState VOID is retained but excluded. Today's closed orders are provisional and totals are incomplete until closeout. Every Toast record and field, one row each: orders, checks, items, modifiers, payments, discounts, service charges (latest import of each day; for today, before the closeout import, the closed orders saved so far with status provisional), plus retained current labor, cash, kitchen, menus and setup objects from authoritative stored Toast records, never diagnostic samples. Use it for anything the other views do not cover. Never use it to rebuild a screen number (net sales, profit, labor cost, card fees, break-even, item cost): use their tools.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never query other cafés. | UUID | app | What data does my café have? |
| source | Always toast. | label | app | Where did this come from? |
| source_ref | Stable reference for this Toast record. | identifier | app | Which record supports it? |
| status | actual: imported evidence; provisional: current-day closed orders saved before closeout. A date range including the café's active business day is incomplete even if every returned row says actual; call it so far, not final. | label | app | Is this final? |
| business_date | Café business date; null for setup lists (menus, tables, discounts, jobs...), which always show the newest copy. | local date | toast | What happened on this date? |
| record_type | Retained record types include order, check, item, employee, modifier, payment, check_discount, item_discount, service_charge, and endpoint-typed objects such as labor/v1/timeEntries, labor/v1/employees, labor/v1/jobs, cashmgmt/v1/entries, config/v2/menuItems, config/v2/tables, menus/v2/menus, kitchen/v1/export/itemFulfillments. A stored employee record uses record_type=employee; that is NOT the same filter as labor/v1/employees. Filter the exact type supplied by the current record. | label | toast | Which kind of record? |
| record_ref | Toast GUID of this record. For a known order or employee GUID, filter cv_toast_records by record_type and record_ref together; do not confuse record_ref with order_ref or source_ref. | identifier | toast | Which record? |
| order_ref | Toast order GUID for the order, check, item, discount and payment rows. Use count_distinct order_ref (not count of discount uses) for different orders; nulls are ignored. | identifier | toast | Which order? |
| check_ref | Toast check GUID for the check and its child records. Multiple checks may belong to one order; count_distinct check_ref is not the same as distinct orders. | identifier | toast | Which check? |
| counts_in_sales | Filter true for counting applied discounts: false for processingState VOID (removed), voided/deleted orders, checks or items, test-mode/excess-food orders, and excluded payments. Null for non-order records. Removed discounts are visible as evidence but never counted as uses. | boolean | app | Did this count? |
| data | Cleaned Toast fields: read named paths such as data.name, data.server.guid, data.price. For retained record_type=employee from the current roster writer, the available un-hashed name is data.display_name (full display name); data.firstName is not stored by that projection and separate first-name components are unavailable unless independently retained. For retained record_type=order, permitted customer first name is data.customer.firstName. Select only the required named path, filter record_ref for a known GUID, and respect field availability. Use describe_data with one record_type to discover unknown paths. Numeric JSON fields support comparisons, sum, min, max and averages; is_null/is_not_null find absent fields without treating them as zero. Group by business_date and any named field for unplanned per-day/per-item questions. Group by data.name for discount names; status VOID is excluded with counts_in_sales, not by summing amounts. Toast JSON money fields are dollar-valued. For the fixture-proven amounts, use price_cents for item prices and discount_amount_cents for item/check discounts; both are integer cents. Neither is the screen net-sales definition. Unproven JSON dollar fields remain unprojected. Customer fields normally belong to record_type=check. data.aiCafeCustomer is a check-derived projection on the same authorized reader: identityRef and visitRef are café/restaurant-scoped observed guest-object or loyalty-account references (null if unresolved), not proof of distinct people. displayName/displayNameSource and payerNameConflict describe labels, never identity. Count eligible check rows versus nonnull identityRef for linkage coverage; count_distinct visitRef for observed order visits. netSalesCents is check-level order-date attribution using importer cents semantics; null when missing, never sum on children. Item, modifier, discount, service-charge and payment rows carry identity/visit references, not check-level names or money. For unknown fields without dedicated views, discover and query named retained paths; absent fields and unknown coverage are not zero. | JSON | toast | Sales by server? Average order time? Which table? |
| price_cents | Toast item data.price projected to integer cents; null when absent or nonnumeric. Not net sales. | cents | toast | What prices were recorded? |
| discount_amount_cents | Toast item/check applied discount data.discountAmount projected to integer cents; filter counts_in_sales=true to exclude VOID uses. | cents | toast | What discount amounts were recorded? |

## cv_customer_visits

Observed linked account visits derived from the existing current eligible Toast checks. One identity/order, not a person. Query end is the historical cutoff; previous history determines first/returning. Use cv_toast_records eligible checks for coverage/unknowns. Cohort flags require elapsed complete source days; observed lower bounds, missing flags are not zero. No names or payment identifiers.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never another café. | UUID | app | What data does my café have? |
| source | Toast operational archive provenance. | label | toast | Where did this come from? |
| source_ref | Scoped visit reference: one identity/order, not a person or payment. | identifier | app | How many observed visits? |
| status | Actual imported or provisional live source; actual does not guarantee identity coverage. | label | app | Is the visit complete? |
| business_date | Café local business date of the observed visit. | local date | toast | When was the visit? |
| identity_ref | Scoped observed guest-object or loyalty-account reference, not unique-person proof. | identifier | app | How many observed accounts? |
| identity_state | Guest-reference or loyalty-account namespace; never merge by name. | label | app | What supports the link? |
| restaurant_ref | Provider restaurant scope. | identifier | toast | Which location? |
| order_ref | Provider order reference: multiple checks/tenders are one visit per linked reference. | identifier | toast | Which order? |
| eligible_check_count | Number of included linked eligible checks. | count | app | How many checks? |
| net_sales_cents | Check-level recorded order-date net sales, null if any money/check uniqueness is unverified. Not all-café sales. | cents | app | Spend per linked visit? |
| known_money_check_count | Included checks with recorded net amount. | count | app | Is spending complete? |
| first_observed_date | First observed visit in retained history as of query end, not first-ever. | local date | app | When first observed? |
| last_observed_date | Most recent observed visit through query end, not a future visit. | local date | app | When last observed? |
| previous_observed_date | Previous observed visit date, null when not observed. | local date | app | When previously visited? |
| next_observed_date | Next observed visit within as-of, null when not observed. | local date | app | When next observed? |
| observed_visit_number | Ordinal visit of observed account in retained history, not unique people. | count | app | Second observed visit? |
| days_since_previous | Days from previous observed visit; null when not observed; same-day can be zero. | days | app | Time between observed visits? |
| days_since_last_observed | Days from last observed visit to query end; repeated on visits, use one row per account for account statistics. | days | app | Which accounts have lapsed? |
| first_observed_visit | 1 on first observed visit, else 0; sum for first-observed accounts, not first-ever customers. | count | app | How many first-observed accounts? |
| returning_visit | 1 for a later observed visit, else 0; sum returning visits, distinct identity_ref for accounts. | count | app | How many returning visits? |
| observed_return_7d | On first-observed visit only: 1 if repeat visit observed within 7 days, 0 if none observed in an elapsed complete source window, null if immature/missing/nonfirst. Average is observed lower-bound return rate among matured linked references; report count denominator and identity coverage, never population retention. | indicator | app | Observed 7-day return rate? |
| observed_return_30d | On first-observed visit only: 1 if repeat visit observed within 30 days, 0 if none observed in an elapsed complete source window, null if immature/missing/nonfirst. Average is observed lower-bound return rate among matured linked references; report count denominator and identity coverage, never population retention. | indicator | app | Observed 30-day return rate? |
| observed_return_60d | On first-observed visit only: 1 if repeat visit observed within 60 days, 0 if none observed in an elapsed complete source window, null if immature/missing/nonfirst. Average is observed lower-bound return rate among matured linked references; report count denominator and identity coverage, never population retention. | indicator | app | Observed 60-day return rate? |
| observed_return_90d | On first-observed visit only: 1 if repeat visit observed within 90 days, 0 if none observed in an elapsed complete source window, null if immature/missing/nonfirst. Average is observed lower-bound return rate among matured linked references; report count denominator and identity coverage, never population retention. | indicator | app | Observed 90-day return rate? |
| history_start_date | Earliest eligible check evidence observed for restaurant, not proof history is complete. | local date | app | How far back is history? |
| as_of_date | Timeline cutoff: earlier of query end and café current date. | local date | app | What is the observation cutoff? |
| period_account_visits | At the last observed visit only: linked visits in the selected period for this scoped account; sum for total visits or average across active accounts. | count | app | Visits per observed account? |
| period_account_net_sales_cents | At the last observed visit only: all linked visit net cents in the selected period, null when any visit amount is unknown. Not lifetime or all-café sales. | cents | app | Which observed accounts spent the most? |
| period_account_revenue_share | At the last observed visit only: account net cents divided by all selected-period linked account net cents. Null if any account money is unknown, negative or total is not positive. Not full-café revenue share; report coverage. | ratio | app | What share of linked revenue did this account contribute? |
| period_account_revenue_share_squared | At the last observed visit only: squared linked-revenue share; sum across the unfiltered selected-period result for concentration (0 to 1). Null when share unavailable. Do not recalculate across filtered rows. | ratio squared | app | How concentrated was linked-account revenue? |
| history_account_net_sales_cents | At the last observed visit only: observed linked visit net cents from retained history through cutoff, null if any amount unknown; not lifetime value or forecast. | cents | app | What is this account's observed historical spend? |
| observed_prior_cadence_days | Mean positive intervisit date gap from at least two prior observed gaps, through current visit only when source days from first observation are complete. Null with insufficient evidence. | days | app | What was the account's observed visit cadence? |
| observed_reactivation_gap_ratio | Current positive intervisit gap divided by prior observed cadence. Requires two prior positive gaps and complete source days; not proof of reactivation or unique-human churn. | ratio | app | Did this returning account reappear after an unusually long observed gap? |
| observed_lapse_gap_ratio | At the last observed visit only: days since last observed visit divided by mean positive observed gap with at least two gaps and complete source days through cutoff. Use a history-wide date start; not proof of loss or population churn. | ratio | app | Which observed accounts have unusually long gaps? |
| order_duration_seconds | Observed order open-to-close seconds once per linked account/order visit; null if time is unavailable or check evidence conflicts. Not queue time or customer satisfaction. | seconds | toast | Did observed order duration change for linked visits? |
| observed_lapse_flag | At last observed visit only: 1 when elapsed days are at least twice the mean positive visit gap, 0 otherwise; null with insufficient cadence or incomplete source days. Query a broad history through the as-of date; not proof of customer loss. | indicator | app | Which observed regular accounts have a long gap? |
| observed_reappearance_flag | 1 for an observed returning visit after at least twice its prior mean positive gap, 0 for other cadence-qualified returning visits; null when insufficient or incomplete evidence. Count and average over eligible visits, not distinct people. | indicator | app | How many observed visits followed a long gap? |
| historical_recipe_cost_cents | Reconciled historical theoretical ingredient cost for this linked visit, rounded once to cents, only when every included check and nonvoid line has exact source mapping and certified historical recipe/price evidence. Null otherwise or outside a bounded query of at most 371 days. Not physical COGS. | cents | app | What historical recipe cost can be attributed to this visit? |
| historical_recipe_contribution_cents | Recorded linked visit net cents minus reconciled historical theoretical recipe cost. Null when either is unavailable. Not net profit or actual COGS; report count of known visits and coverage before aggregating. | cents | app | What was the observed ingredient-cost contribution? |

## cv_customer_products

Current-source customer product, option and basket evidence. Filter one fact_kind before aggregation; visit_class distinguishes observed returning, first and unresolved. Item/modifier units and pair counts are different grains. Pairs are observed within linked visits only, not every basket; incomplete or missing product identifiers remain unknown. No check-level money or inferred variant, person or profit.

| Column | Meaning | Unit | Source | Example owner question |
|---|---|---|---|---|
| business_id | Authenticated café UUID; never another café. | UUID | app | Which café? |
| source | Toast operational archive provenance. | label | toast | Where did this come from? |
| source_ref | Current source selection or derived sorted linked-visit pair reference. | identifier | app | What supports this fact? |
| status | Actual imported or provisional live source; not a guarantee of identity or product coverage. | label | app | Is the source final? |
| business_date | Local business date of eligible selection or linked basket. | local date | toast | When bought? |
| restaurant_ref | Provider restaurant scope. | identifier | toast | Which location? |
| identity_ref | Scoped observed account reference; null when unlinked or visit classification cannot be established. | identifier | app | Which observed account? |
| visit_ref | Linked account/order visit reference, not a person; null for unresolved selections. | identifier | app | How many linked visits? |
| order_ref | Provider order reference. | identifier | toast | Which order? |
| check_ref | Provider check reference on item or modifier; null for a visit-grain pair. | identifier | toast | Which check? |
| visit_class | Observed first, observed returning, or unresolved. Earlier history decides; first observation is not true acquisition. | label | app | Which items did returning accounts buy? |
| fact_kind | item, modifier or basket_pair. Filter a single kind before aggregating units or pair occurrences. | label | app | Which product fact grain? |
| product_ref | Provider menu item GUID; for modifiers the parent product GUID if uniquely retained; for pairs the smaller stable product GUID. Never a free-text name or inferred variant. | identifier | toast | Which product or size-specific item? |
| item_group_ref | Provider item group GUID where retained; not an invented variant identity. | identifier | toast | Which recorded item group? |
| modifier_ref | Provider modifier item GUID on modifier facts only. | identifier | toast | Which option or modifier was selected? |
| option_group_ref | Provider option group GUID where retained; no assumed size mapping. | identifier | toast | Which recorded option group? |
| paired_product_ref | Larger stable product GUID for a sorted distinct-product linked basket pair only. | identifier | toast | Which two products co-occurred? |
| quantity | Provider recorded nonvoid selection quantity on item or modifier rows, null for unknown or duplicate selection refs and basket pairs. Do not multiply modifier quantities by parent quantity. | units | toast | How many recorded item or modifier units? |
| pair_occurrence | 1 for each distinct unordered product pair in a linked visit, across split checks. Null on item/modifier facts; sum for observed pair count, not population basket coverage. | count | app | How many linked baskets included both products? |
| order_channel | Known normalized ordering channel, other recorded category, or null. | label | toast | Which channel? |
| local_hour | Order open hour in café timezone; null if unavailable. | hour 0 to 23 | app | Which daypart? |
| business_weekday | ISO local business-date weekday (Monday=1). | weekday | app | Which weekday? |

# LEGACY DIAGNOSTIC SOURCE WARNING — NOT AN OPERATING CONTRACT

**POS0e authorized-scope preflight (2026-11-09, implementation not yet proven):** The approved queue grants POS0e only its 18 exact file paths for the existing current-source reader, redactor, dictionary and disposable SQL/agent tests. `toast_raw_records` is current operational truth; `toast_raw_changes` is the change log; `toast_raw_samples` / `toast_raw_samples_latest` remain diagnostic only. Existing SQL consumers still require a verified additive cutover; this note alone neither changes runtime behavior nor authorizes production migration, data deletion or deployment.

**Generated-dictionary contradiction requiring later code ownership (2026-11-07):** The `cv_toast_records` summary **above this footer** is generated from `lib/data/canonical/dictionary.ts` and still says non-order labor/cash/kitchen/menu/setup data comes “from the daily capture.” That is a **historical description of a known current-reader defect**, not the approved source: `toast_raw_samples` is diagnostic-only. The generator `scripts/gen-data-dictionary.mjs` combines the runtime dictionary and this notes footer; editing only the generated summary would be overwritten and would not correct runtime metadata. **POS0e (separate owner-approved implementation)** must fix `dictionary.ts`, regenerate this Markdown, replace SQL active readers and test final migrated direct/transitive dependencies. **POS0f** independently verifies final source-to-Supervisor/screen parity. Until then, follow `docs/rules/pos-data.md` and the #398 handoff; do not re-enable daily diagnostic capture, use old captured values as current, or assume this document proves runtime migration. Preserve historical migration files unchanged.



**Use [binding POS source authority](rules/pos-data.md) instead.** This note describes a historical implementation defect, **not** permission to connect Supervisor or operational views to `toast_raw_samples`. The current code can still read diagnostic snapshots through `cv_cash`, `cv_inventory`, `cv_kitchen`, `cv_dining_options` and non-order `toast_records_for`. POS0e must cut over those active SQL definitions to real current objects, then POS0f verifies and retires stale diagnostic artifacts. Never call these captured values live; `toast_raw_samples` has no authority for current café decisions.


`cv_cash`, Toast rows of `cv_inventory`, `cv_kitchen` and `cv_dining_options` are derived from **redacted diagnostic snapshots** in `toast_raw_samples`; they are not continuously imported operational data. A missing capture, failed response or zero returned rows does not establish an operational zero. Repeated captures can record the same underlying event multiple times, so they must not be summed as daily totals without deduplication.

- **Cash:** `cashmgmt/v1/entries` and `cashmgmt/v1/deposits` expose cash entry/deposit amounts and identifiers. Drawer/employee names are not included in these endpoints; separately collected configuration and labor data would be needed for names.
- **Stock:** `stock/v1/inventory` returns only `OUT_OF_STOCK` or `QUANTITY` menu items. Missing items are not evidence of a zero balance or a confirmed `IN_STOCK` status.
- **Kitchen prep stations:** Configuration rows from `kitchen/v1/published/prepStations` carry `guid` and `name`, not the fulfillment-only `prepStationGuid` and `prepStationName`. These are both projected safely (migration 118).
- **Kitchen:** `kitchen/v1/export/itemFulfillments` and `kitchen/v1/published/prepStations` expose fulfillment timestamps and prep-station data where available. Item fulfillment requires eligible KDS/Toast subscription access; a 204 or no data does not mean preparation took zero time.
- **Excluded/superseded orders:** `cv_orders` retains these non-current rows with `status='needs_match'` and review flags instead of hiding them. They are available for explanation but must not be summed into current sales totals.
- **Dining options:** `config/v2/diningOptions` provides names only where captured. `cv_orders` exposes stored `orders.dining_option`, `source_channel` and `guest_count` regardless of whether the configuration endpoint is available.

**Historical context, not a deployment instruction:** This old note described migration 114–118 dependencies when those migrations were first authored. **Do not apply or reapply these migrations because this page says so.** Verify current migration state against the actual database and current approved migration plan; never edit previously applied migration files. The now **manual-only** diagnostic capture is performed by `captureToastRawSample` via `.github/workflows/toast-diagnostic-capture-manual.yml`; it is not an operating import. The 10-minute Toast sync and future POS0e–f cutover are separate. The existence of historical cash/stock/kitchen diagnostic projections is not proof of live parity or current data availability.
