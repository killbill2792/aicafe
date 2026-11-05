## 4b. POS data: keep every field, read everything, include today
- **Keep every field, once.** "Keep everything" means every field the POS sends is kept; it never means
  keeping copies. The owner rule (Nov 3, plan: `docs/plans/toast-storage.md`):
  - **One current raw record per POS object** (order, payment, time entry…), with every field, filed under
    its own business date. The database enforces it with a unique key; every save is "same → nothing,
    different → update". Comparisons ignore list order (Toast reorders lists between downloads).
  - **A change log** keeps real changes (field, before, after, when), never a second full copy.
  - **Organized tables** hold every field the app uses, also one row per order/item/payment by unique key,
    rebuilt from the raw record. Add columns as needed; never rename or drop ones in use.
  - **A daily health check** reports database size, duplicates, daily totals vs the POS day total and
    sudden growth on the admin page (`/admin/health`); café owners never see system alerts. Storage tests use real POS messiness (reordered lists, repeats, re-pulls).
- **Every endpoint is captured.** Every Toast endpoint the café's credentials allow is captured on a schedule
  (`.github/workflows/toast-raw-capture-daily.yml`, last three closed days kept complete) into
  `toast_raw_samples`, with customer personal details removed and business data kept. Views read only
  the newest successful capture of each day.
- **The AI can read all of it** through the canonical views and the one read-only data-query tool, with a
  plain-words dictionary entry for every source. "Missing" means the POS truly returned nothing (or we
  lack permission), and the AI says exactly which.
- **Today counts.** A "today so far" live layer refreshes changed data every 10–15 minutes during open
  hours (orders, payments, time entries, stock, cash). It is labeled provisional and is replaced by the
  final import after closeout. It feeds the same views; it is not a second pipeline.
- Setup data (discounts, tax rates, revenue centers…) refreshes daily.
