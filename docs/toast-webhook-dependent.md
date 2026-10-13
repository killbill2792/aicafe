# Toast signed Orders webhook — dependent PR 3

Adds a disabled-by-default, read-only inbound webhook and event queue. Signature is SHA-256 HMAC of the exact HTTP body concatenated with the event timestamp (as documented by Toast), verified in constant time with a subscription-specific AES-GCM-encrypted secret. Rejects timestamp replays older than five minutes, GUID mismatches and unverified locations. Event GUID primary key makes duplicate delivery idempotent. No raw payloads are persisted, no Supervisor/AI Team decisions are made, and no canonical facts are changed.

TOAST_WEBHOOKS_ENABLED must remain unset/false. No subscription is enabled by default; no provisioning UI and no scheduler is activated. A separate authenticated subscription setup workflow is required before authorized pilot activation. Event processing and safe canonical sync remain incomplete. Do not merge as a full integration, and do not enable this route with test secrets.
