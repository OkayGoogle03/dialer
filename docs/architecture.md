# Architecture

```
 Browser (React, JsSIP)    Windows (Electron + PJSIP)
          │ HTTPS/WSS                 │ HTTPS / SIP-TLS + SRTP
          ▼                           ▼
   ┌──────────────┐           ┌──────────────┐
   │  API (NestJS)│◄──NATS───►│  Kamailio    │  SIP edge, registrar, LB, anti-fraud
   │  /api/v1     │ JetStream └──────┬───────┘
   └──────┬───────┘                  ▼
          │                   ┌──────────────┐   ARI (WS/REST)  ┌───────────────────┐
          │                   │  Asterisk ×N │◄────────────────►│ telephony-adapter │
          │                   └──────┬───────┘                  └───────────────────┘
          │                          │ RTP (External Media)
          ▼                          ▼
   PostgreSQL (RLS)          ┌──────────────┐  16 kHz PCM  ┌─────────────────────┐
   Redis                     │ media-gateway│◄────────────►│ ai-orchestrator      │
   S3 (recordings)           └──────────────┘              │ (FastAPI: STT/LLM/TTS)│
                                                           └─────────────────────┘
```

## Service ownership
| Service | Owns | Status |
|---|---|---|
| `services/api` | Auth, tenancy, RBAC, CRUD for all business entities, REST + WS to clients, outbox | Phase 1 (in progress) |
| `services/telephony-adapter` | ARI call control, call state → events, dialer pacing workers | Phase 2 |
| `services/media-gateway` | RTP rx/tx, codec/resample, jitter buffer, VAD, per-call isolation | Phase 5 |
| `services/ai-orchestrator` | STT/LLM/TTS provider abstractions, conversation state machine, tools | Phase 5–6 |
| `apps/web` | Admin, agent, supervisor UI, WebRTC softphone | Phase 1+ |
| `apps/desktop` | Electron shell + native PJSIP addon | Phase 3 |

## Request path & tenancy
1. JWT verified by global `AuthGuard` → `req.user.tenantId` (from `tid` claim only).
2. Services call `Database.withTenant(tenantId, fn)` → `BEGIN; SET app.tenant_id; …; COMMIT`.
3. Postgres RLS filters every tenant table; composite FKs block cross-tenant references.
4. Pre-auth lookups use narrow SECURITY DEFINER functions (`app.resolve_tenant`, `app.public_branding`).

## Scaling notes
Telephony (Kamailio/Asterisk/media) runs on dedicated nodes, scaled by session-aware draining (Kamailio dispatcher flags), not by blind HPA. API and AI orchestrator are stateless and horizontally scalable. See `deployment.md`.
