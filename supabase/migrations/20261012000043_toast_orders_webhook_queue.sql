-- Toast Orders webhook: event-only queue. Never persist raw customer/payment payloads.
-- Installation manual after migrations 40, 41, 42; no existing tables modified.
CREATE TABLE IF NOT EXISTS toast_webhook_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES toast_api_credentials(business_id) ON DELETE CASCADE,
 signing_secret_enc text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS toast_webhook_subscriptions_business_idx
 ON toast_webhook_subscriptions(business_id);
CREATE TABLE IF NOT EXISTS toast_order_events (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 event_guid uuid NOT NULL,
 restaurant_guid uuid NOT NULL,
 event_time timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'pending'
   CHECK (state IN ('pending','processing','complete','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_failure_category text,
 PRIMARY KEY(business_id,event_guid),
 FOREIGN KEY(business_id,restaurant_guid)
 REFERENCES toast_location_mappings(business_id,restaurant_guid)
);
CREATE INDEX IF NOT EXISTS toast_order_events_pending_idx
 ON toast_order_events(state,next_attempt_at);
ALTER TABLE toast_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE toast_order_events ENABLE ROW LEVEL SECURITY;
-- Webhook secret and event processing queue are service-role only.
REVOKE ALL ON toast_webhook_subscriptions,toast_order_events FROM PUBLIC,anon,authenticated;
