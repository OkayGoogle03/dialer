-- 0002: provider catalogue, tenant trunks, caller IDs, extensions, queues, dispositions, calls, recordings.

-- Platform catalogue of provider templates (no secrets).
CREATE TABLE IF NOT EXISTS sip_providers (
  id               CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  `key`            VARCHAR(50) CHARACTER SET ascii NOT NULL,
  name             VARCHAR(100) NOT NULL,
  default_settings JSON NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sip_providers_key (`key`)
);

INSERT IGNORE INTO sip_providers (id, `key`, name, default_settings) VALUES
  ('00000000-0000-4000-8000-000000000001', 'generic', 'Generic SIP trunk', '{"transport":"tls","codecs":["opus","g722","ulaw","alaw"]}');

CREATE TABLE IF NOT EXISTS tenant_sip_providers (
  id                     CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id              CHAR(36) CHARACTER SET ascii NOT NULL,
  sip_provider_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  name                   VARCHAR(100) COLLATE utf8mb4_general_ci NOT NULL,
  host                   VARCHAR(253) NOT NULL,
  port                   INT NOT NULL DEFAULT 5061,
  transport              VARCHAR(8) NOT NULL DEFAULT 'tls',
  auth_username          VARCHAR(200) NULL,
  auth_secret_encrypted  TEXT NULL,          -- AES-256-GCM; never returned by any API
  auth_mode              VARCHAR(16) NOT NULL DEFAULT 'digest',
  priority               INT NOT NULL DEFAULT 100,
  weight                 INT NOT NULL DEFAULT 100,
  max_concurrent_calls   INT NOT NULL DEFAULT 30,
  allowed_country_codes  JSON NULL,          -- array of ISO-3166 alpha-2; empty/null = none allowed
  settings               JSON NULL,
  status                 VARCHAR(16) NOT NULL DEFAULT 'active',
  health_status          VARCHAR(16) NOT NULL DEFAULT 'unknown',
  circuit_state          VARCHAR(16) NOT NULL DEFAULT 'closed',
  last_health_check_at   DATETIME(3) NULL,
  cost_per_minute_micros BIGINT NOT NULL DEFAULT 0,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at             DATETIME(3) NULL,
  live                   TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_tsp_tenant_id (tenant_id, id),
  UNIQUE KEY uq_tsp_name (tenant_id, name, live),
  KEY ix_tsp_routing (tenant_id, status, priority),
  CONSTRAINT fk_tsp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_tsp_provider FOREIGN KEY (sip_provider_id) REFERENCES sip_providers (id)
);

CREATE TABLE IF NOT EXISTS caller_ids (
  id                  CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id           CHAR(36) CHARACTER SET ascii NOT NULL,
  e164                VARCHAR(16) CHARACTER SET ascii NOT NULL,
  verified_at         DATETIME(3) NULL,
  verification_method VARCHAR(50) NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_caller_ids_tenant_id (tenant_id, id),
  UNIQUE KEY uq_caller_ids_e164 (tenant_id, e164),
  CONSTRAINT fk_caller_ids_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS extensions (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  number               VARCHAR(8) CHARACTER SET ascii NOT NULL,
  user_id              CHAR(36) CHARACTER SET ascii NULL,
  sip_username         VARCHAR(64) CHARACTER SET ascii NOT NULL,  -- realm-wide unique, server-derived
  sip_secret_encrypted TEXT NOT NULL,
  webrtc_enabled       TINYINT(1) NOT NULL DEFAULT 1,
  status               VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at           DATETIME(3) NULL,
  live                 TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_extensions_tenant_id (tenant_id, id),
  UNIQUE KEY uq_extensions_sip_username (sip_username),
  UNIQUE KEY uq_extensions_number (tenant_id, number, live),
  CONSTRAINT fk_extensions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_extensions_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS queues (
  id                CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id         CHAR(36) CHARACTER SET ascii NOT NULL,
  name              VARCHAR(100) COLLATE utf8mb4_general_ci NOT NULL,
  strategy          VARCHAR(16) NOT NULL DEFAULT 'rrmemory',
  max_wait_seconds  INT NOT NULL DEFAULT 300,
  wrapup_seconds    INT NOT NULL DEFAULT 10,
  recording_enabled TINYINT(1) NOT NULL DEFAULT 1,
  settings          JSON NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3) NULL,
  live              TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_queues_tenant_id (tenant_id, id),
  UNIQUE KEY uq_queues_name (tenant_id, name, live),
  CONSTRAINT fk_queues_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_agents (
  tenant_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  queue_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  penalty    INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (queue_id, user_id),
  KEY ix_queue_agents_user (tenant_id, user_id),
  CONSTRAINT fk_qa_queue FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_qa_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_dispositions (
  id                  CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id           CHAR(36) CHARACTER SET ascii NOT NULL,
  code                VARCHAR(40) CHARACTER SET ascii NOT NULL,
  label               VARCHAR(100) NOT NULL,
  is_success          TINYINT(1) NOT NULL DEFAULT 0,
  is_dnc              TINYINT(1) NOT NULL DEFAULT 0,
  retry_after_minutes INT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at          DATETIME(3) NULL,
  live                TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_dispositions_tenant_id (tenant_id, id),
  UNIQUE KEY uq_dispositions_code (tenant_id, code, live),
  CONSTRAINT fk_dispositions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

-- Call history. TiDB distributes rows across regions automatically; random UUID keys avoid write hotspots.
CREATE TABLE IF NOT EXISTS call_sessions (
  id                     CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id              CHAR(36) CHARACTER SET ascii NOT NULL,
  direction              VARCHAR(16) NOT NULL,
  status                 VARCHAR(16) NOT NULL DEFAULT 'created',
  from_number            VARCHAR(32) NULL,
  to_number              VARCHAR(32) NULL,
  user_id                CHAR(36) CHARACTER SET ascii NULL,
  queue_id               CHAR(36) CHARACTER SET ascii NULL,
  campaign_id            CHAR(36) CHARACTER SET ascii NULL,
  contact_id             CHAR(36) CHARACTER SET ascii NULL,
  tenant_sip_provider_id CHAR(36) CHARACTER SET ascii NULL,
  disposition_id         CHAR(36) CHARACTER SET ascii NULL,
  idempotency_key        VARCHAR(200) NULL,
  hangup_cause           VARCHAR(100) NULL,
  correlation_id         VARCHAR(100) NULL,
  started_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  answered_at            DATETIME(3) NULL,
  ended_at               DATETIME(3) NULL,
  duration_seconds       INT AS (IF(ended_at IS NULL, NULL, GREATEST(0, TIMESTAMPDIFF(SECOND, started_at, ended_at)))) VIRTUAL,
  billable_seconds       INT AS (IF(ended_at IS NULL OR answered_at IS NULL, NULL, GREATEST(0, TIMESTAMPDIFF(SECOND, answered_at, ended_at)))) VIRTUAL,
  metadata               JSON NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_call_sessions_tenant_id (tenant_id, id),
  UNIQUE KEY uq_call_sessions_idempotency (tenant_id, idempotency_key),
  KEY ix_call_sessions_started (tenant_id, started_at),
  KEY ix_call_sessions_user (tenant_id, user_id, started_at),
  KEY ix_call_sessions_status (tenant_id, status),
  KEY ix_call_sessions_campaign (tenant_id, campaign_id),
  CONSTRAINT fk_cs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_cs_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT fk_cs_queue FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id),
  CONSTRAINT fk_cs_provider FOREIGN KEY (tenant_id, tenant_sip_provider_id) REFERENCES tenant_sip_providers (tenant_id, id),
  CONSTRAINT fk_cs_disposition FOREIGN KEY (tenant_id, disposition_id) REFERENCES call_dispositions (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS call_legs (
  id              CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  call_session_id CHAR(36) CHARACTER SET ascii NOT NULL,
  leg_type        VARCHAR(16) NOT NULL,
  channel_id      VARCHAR(128) NULL,
  sip_call_id     VARCHAR(255) NULL,
  endpoint        VARCHAR(255) NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'created',
  codec           VARCHAR(16) NULL,
  started_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  answered_at     DATETIME(3) NULL,
  ended_at        DATETIME(3) NULL,
  hangup_cause    VARCHAR(100) NULL,
  quality         JSON NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_call_legs_tenant_id (tenant_id, id),
  KEY ix_call_legs_session (tenant_id, call_session_id),
  KEY ix_call_legs_channel (channel_id),
  CONSTRAINT fk_cl_session FOREIGN KEY (tenant_id, call_session_id) REFERENCES call_sessions (tenant_id, id) ON DELETE CASCADE
);

-- High-volume append-only. Not partitioned: TiDB does not support FKs on partitioned tables and already
-- shards by key range; retention is handled by a TTL job (Phase 2). See decisions D-016.
CREATE TABLE IF NOT EXISTS call_events (
  id              CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  call_session_id CHAR(36) CHARACTER SET ascii NOT NULL,
  call_leg_id     CHAR(36) CHARACTER SET ascii NULL,
  event_type      VARCHAR(64) NOT NULL,
  payload         JSON NULL,
  occurred_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_call_events_session (tenant_id, call_session_id, occurred_at),
  CONSTRAINT fk_ce_session FOREIGN KEY (tenant_id, call_session_id) REFERENCES call_sessions (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recordings (
  id               CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  call_session_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  storage_bucket   VARCHAR(63) NOT NULL,
  storage_key      VARCHAR(512) NOT NULL,
  format           VARCHAR(8) NOT NULL DEFAULT 'wav',
  channels         SMALLINT NOT NULL DEFAULT 2,
  duration_seconds INT NULL,
  size_bytes       BIGINT NULL,
  sha256           CHAR(64) CHARACTER SET ascii NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'recording',
  consent_obtained TINYINT(1) NULL,
  retain_until     DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at       DATETIME(3) NULL,
  UNIQUE KEY uq_recordings_tenant_id (tenant_id, id),
  UNIQUE KEY uq_recordings_object (storage_bucket, storage_key),
  KEY ix_recordings_session (tenant_id, call_session_id),
  KEY ix_recordings_retention (status, retain_until),
  CONSTRAINT fk_rec_session FOREIGN KEY (tenant_id, call_session_id) REFERENCES call_sessions (tenant_id, id) ON DELETE CASCADE
);
