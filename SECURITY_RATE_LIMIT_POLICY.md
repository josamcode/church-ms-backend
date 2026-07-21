# Rate Limit And Abuse-Control Policy

Production rate limiting must use Redis. The application validates `REDIS_REQUIRED=true` in production and the limiter factory fails startup if Redis-backed storage is required but unavailable.

| Endpoint group | Keying strategy | Window | Max requests | Reason | Redis required | Expected user impact |
| --- | --- | ---: | ---: | --- | --- | --- |
| Global API baseline | Authenticated user when a valid access token is present, otherwise IP | 15 min | 600 anonymous / 5000 authenticated | Caps broad API floods, including unknown API paths | Production | Normal browsing and admin sessions stay below the ceiling |
| Public reads | IP | 15 min | 300 | Caps scraping of public content, archive, booking slots, settings, and registration options | Production | Normal visitors unaffected |
| Login | IP and normalized login identifier hash | 15 min | 30 per IP / 8 per identifier | Slows brute force by source and targeted account | Production | Allows a few mistakes, then asks user to wait |
| Register | IP and submitted phone/email/national-id hash | 1 hour | 10 per IP / 3 per identifier | Prevents registration spam | Production | Normal family registration unaffected |
| Refresh/logout/password | Authenticated user when available, otherwise IP/token fingerprint | 15 min | 60 refresh/logout, 10 password changes | Limits replay loops and password brute-force attempts | Production | Normal session behavior unaffected |
| Public booking create | IP and requester phone/email hash | 1 hour | 12 per IP / 4 per requester | Stops public booking spam before slot/storage ownership work | Production | Allows normal repeated bookings |
| Public booking image upload | IP before multipart parsing | 1 hour | 20 public uploads/IP plus 60 uploads/user-or-IP globally | Blocks memory/storage abuse before `multer` buffers the file | Production | Allows normal image retry flows |
| All file uploads | Authenticated user when available, otherwise IP | 1 hour | 60 | Protects memory and object storage across upload endpoints | Production | Allows normal admin upload batches |
| Analytics sync | Authenticated user, otherwise session/visitor hash, otherwise IP | 1 hour | 240 | Tolerates normal active sessions while capping telemetry floods | Production | Browser sync cadence passes |
| Authenticated/admin mutations | Authenticated user when token is valid, otherwise IP | 15 min | 600 | Stops accidental loops and write-path abuse before expensive handlers | Production | Normal admin work unaffected |
| Chat messages | Authenticated user | 1 min | 60 | Prevents message spam | Production | Sustained one message per second allowed |
| Push subscription mutations | Authenticated user | 15 min | 30 | Prevents subscription churn and malformed payload spam | Production | Normal subscribe/unsubscribe flows pass |
| AI generation endpoints | Authenticated user | 60 min | 60 | Bounds provider spend and latency exposure; layered with per-user daily AI quotas and a hard monthly spend ceiling | Production | Well above expected drafting use; only automated abuse reaches it |

AI-specific controls layered on top of the rate limiter:

| Control | Scope | Value | Behaviour at the limit |
| --- | --- | ---: | --- |
| Per-user daily quota | user + feature | 50 drafts / 30 narratives / 5 import explanations | `429 AI_QUOTA_EXCEEDED` |
| Per-role daily quota | role | 200 SUPER_ADMIN / 100 ADMIN / 0 USER | `429 AI_QUOTA_EXCEEDED` |
| Per-feature daily quota | system-wide | 500 / 300 / 50 | `429 AI_QUOTA_EXCEEDED` |
| Daily spend ceiling | system-wide | `AI_DAILY_SPEND_USD` (default $5) | `503 AI_QUOTA_EXCEEDED`, provider never contacted |
| Monthly spend ceiling | system-wide | `AI_MONTHLY_SPEND_USD` (default $100) | `503 AI_QUOTA_EXCEEDED`, full stop for the month |
| Circuit breaker | per provider | 5 consecutive failures | Skip straight to fallback for `AI_CIRCUIT_RESET_MS` |

The rate limiter bounds requests per hour to protect latency and the provider
connection; the quotas bound requests per day to protect cost. They are
independent — a caller can be inside the rate limit and out of quota, or the
reverse — and both must pass.

Quotas are consumed only once a provider has actually been contacted, so a
request rejected by a kill switch, the redaction gate, or the rate limiter does
not spend a user's daily allowance.

Deployment notes:

- Set `TRUST_PROXY` only to the actual number of trusted proxy hops or a known proxy setting supported by Express. Do not enable broad proxy trust for direct internet exposure.
- Keep health checks outside the limiter path (`/api/health`) so infrastructure probes do not cause false incidents.
- Upload routes must keep rate limiting before `multer` to block abusive requests before memory buffering or storage calls.
