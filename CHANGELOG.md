# Changelog

## 0.3.1

- Preserve a verified live SSH process through short public health failures. Three consecutive ordinary failures mark the entry degraded with `lastHealthyAt`; malformed or mismatched entry responses degrade immediately. Matching health restores online status, while real SSH exits and forwarding failures still reconnect.
- Add bounded Core-loss credential recovery: coalesce one refresh per outage, reuse the existing renewer's network retries, and nudge Core at most once only while it remains connecting. Self-recovered active streams, expired credentials, and disposed Clients are not interrupted by late recovery results.
- Stream gzip level 1 for eligible authenticated `GET /plugins/` static scripts/resources before the SSH hop. Preserve identity negotiation, existing encodings, range/error/HEAD behavior, Cookie and redirect rewriting, and stream revocation; business API, JSON, SSE, and WS traffic remain outside HTTP compression.
- Show degraded health separately from reconnection and expose the last successful public verification time. Include the self-contained recovery helper and its build source/tests in the release package.
- Document optional SSH payload compression and deployment-specific Core WAN budgets. The public plugin does not change Core's default heartbeat/readiness timings or move DSH, provider configuration, or projects to a relay.
- Keep the DSH compatibility range `>=0.2.1-rc.2 <0.3.0`, local-user enable/pair controls, exact authority checks, persistent Off/revocation semantics, and Strict HttpOnly cookies unchanged. Use reserved example domains in test fixtures.

## 0.3.0

- Add optional fixed-domain HTTPS access through a restricted SSH reverse tunnel and a user-managed TLS gateway. Cloudflare Quick Tunnel remains the default; DSH, projects, and provider configuration stay local.
- Add opt-in local device persistence containing only the current refresh hash, expiry, device metadata, and entry intent. Controlled reloads preserve same-domain refresh grants and device IDs; old access credentials are not restored, so the next valid refresh exchanges a new Core cookie for the current Host.
- Keep explicit Off and device revocation durable. Off clears grants and records disabled intent. `autoStart` defaults to false and requires explicit configuration; a persisted Off takes precedence, while an empty store can start when automatic enablement is explicitly configured.
- Add public health checks with a per-bridge entry ID, no credentials or device details, no cookies, and no caching. SSH readiness requires both the owned forward and matching public health; enabled, online, reconnecting, and offline remain distinct states.
- Reconnect SSH without discarding valid device grants. Start browser renewal on owned HTTPS domains only after a valid bridge health marker, and cancel probes during disposal.
- Offer the existing no-secret recovery page for genuine top-level homepage HTML 401s, retaining current-access confirmation, fixed-homepage navigation, Strict cookies, and unchanged API/POST/WebSocket authorization.
- Document fixed-domain setup, loopback-only SSH forwarding, Nginx WebSocket/stream proxying, and certificate maintenance. HTTP-01 depends on the actual deployment; standalone TLS-ALPN maintenance that takes over 443 requires an outage window and service restoration.
- Preserve local-user-only enablement/pairing management and the DSH compatibility range `>=0.2.1-rc.2 <0.3.0`. Changing domains requires a new pairing; stores support one writer, and the 120-second rotation grace is not persisted. A crash after disk rotation but before browser cookie application can require pairing again.

## 0.2.2

- Recover an already paired browser that reopens the old pairing address without a one-use secret: refresh and confirm its HttpOnly cookies, then enter the fixed homepage.
- Preserve explicit device-name confirmation for fresh QR codes; distinguish expired/unavailable credentials from retryable connection failures without automatic loops.
- Keep existing cookie protections and paired-device identity; ordinary metadata reads retain transparent renewal.

## 0.2.1

- Fix **Add workspace** (`AddWorkspace`) opening an OS directory dialog on the DSH computer when used from a remote browser. The bundle disables the standard Web profile's automatic directory picker and explicitly loads Core's browse Host and browse Client, so the chooser opens in the browser that requested it and selects directories on the DSH Host.
- Apply the browser chooser to the entire profile while this bundle is enabled, including local browsers and periods when remote access is switched off. Custom compositions must avoid multiple active directory-picker backends.
- Update installation examples to `v0.2.1`; dsh-mobile remains at `v0.1.0`.
