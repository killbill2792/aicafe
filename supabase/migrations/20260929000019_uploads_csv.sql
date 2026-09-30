-- Wires the existing (previously unused) uploads table into the sales/labor/ingredients CSV
-- importers so an owner can see what any past upload actually did, and so an unmatched-item
-- problem can be flagged instead of silently absorbed.
alter table uploads alter column storage_path drop not null; -- CSV imports parse client-side, no file ever reaches Storage
alter table uploads drop constraint if exists uploads_kind_check;
alter table uploads add constraint uploads_kind_check check (kind in ('statement', 'receipt', 'pos_csv', 'sales_csv', 'labor_csv', 'ingredients_csv'));

-- A new alert kind for a sales import whose item names didn't match anything on the menu —
-- the same check-constraint pattern this table already has for its other 7 kinds.
alter table alerts drop constraint if exists alerts_kind_check;
alter table alerts add constraint alerts_kind_check check (kind in ('missing_bill', 'voids', 'meal_break', 'early_clockin', 'underpriced', 'overstaffed', 'covered_milestone', 'unmatched_sales_items'));
