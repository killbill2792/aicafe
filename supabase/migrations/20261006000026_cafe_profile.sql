-- Café profile foundation: location address fields complement the existing business identity
-- and locations.open_hours. All fields are nullable so existing cafés remain unknown, never
-- silently inferred from defaults.
alter table locations add column if not exists address_line1 text;
alter table locations add column if not exists address_line2 text;
alter table locations add column if not exists city text;
alter table locations add column if not exists region text;
alter table locations add column if not exists postal_code text;
alter table locations add column if not exists country_code text;

alter table locations drop constraint if exists locations_country_code_check;
alter table locations add constraint locations_country_code_check
  check (country_code is null or country_code ~ '^[A-Z]{2}$');
