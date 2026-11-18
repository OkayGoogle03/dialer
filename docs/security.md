# Security

## Implemented (Phase 1)
- **Tenant isolation (no RLS on TiDB):** tenant id only from the verified JWT; SQL scope guard; composite FKs; separate DB users with least-privilege grants; platform privileges only via `dialer_platform` plus `platform_admins` (re-checked per request). Tests prove cross-tenant FK and grant denials.
- **Auth:** scrypt password hashing; constant-work path for unknown users; generic "Invalid credentials" for unknown tenant/user/password; lockout (5 failures → 15 min); short-lived HS256 access JWT with issuer check; refresh rotation with reuse detection; disabling a user revokes their refresh tokens; suspended tenants cannot log in or refresh.
- **RBAC:** permission-based (`@RequirePermissions`), system roles seeded per tenant; only tenant admins may grant `tenant_admin`; users cannot disable/demote themselves.
- **Input:** class-validator with whitelist + forbidNonWhitelisted; HTTPS-only URLs and hex colours enforced in both DTO and DB CHECKs.
- **Transport/headers:** helmet; CORS allow-list; refresh cookie httpOnly + SameSite=Strict + Secure in production, path-scoped.
- **Rate limiting:** global 300/min/IP; login 10/min/IP; refresh 30/min/IP.
- **Audit:** login success/failure/lockout, refresh-token reuse, logout, user create/update, branding update — written in the same transaction as the change; audit table is append-only for the runtime role.

- **Credentials (Batch 3):** SIP trunk and ARI passwords are AES-256-GCM encrypted at rest (`CREDENTIALS_ENCRYPTION_KEY`), write-only in every API, absent from logs and audit metadata (tested), decrypted only to run a connectivity check or originate a call. PJSIP config generation rejects values that could inject sections/lines and masks secrets in previews.
- **Uploads:** extension + MIME + ZIP magic-byte checks, 4 MB / 5000-row limits, no formulas accepted, tenant comes only from the login token (an Excel `Tenant` column is rejected). Error reports neutralise CSV/formula injection.
- **Probes:** see D-036 (SSRF).

## Planned
| Control | Phase |
|---|---|
| SIP/provider credential encryption (AES-256-GCM, key from secret manager), never returned to clients; extensions get short-lived SIP credentials via backend | 2 |
| TLS for SIP, SRTP/DTLS-SRTP, Kamailio pike/anti-flood, destination/country allow-lists, spend & concurrency limits, caller-ID validation | 2 |
| Signed, short-TTL recording URLs; retention purge jobs; export permission checks | 2 |
| DNC suppression check before every dial; calling windows by contact timezone; abandonment caps; consent + opt-out handling; AI disclosure | 4–6 |
| Password reset, MFA (TOTP), SSO | 7 |
| Secrets via Kubernetes secrets / external secret manager; network policies; WAF | 7 |

**Compliance:** rules differ by jurisdiction (e.g. India TRAI TCCCPR/DLT registration and DPDP Act; US TCPA; EU/UK GDPR/PECR). Configuration is per tenant; **legal review is required before any production automated or predictive campaign** (enforced by `campaigns.legal_review_confirmed_at`, start-guard TODO Phase 4).
