-- 0003: contacts, lists, DNC suppression, consent, campaigns.

CREATE TABLE IF NOT EXISTS contact_lists (
  id          CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  name        VARCHAR(200) NOT NULL,
  source      VARCHAR(255) NULL,
  created_by  CHAR(36) CHARACTER SET ascii NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3) NULL,
  UNIQUE KEY uq_contact_lists_tenant_id (tenant_id, id),
  CONSTRAINT fk_contact_lists_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_contact_lists_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id              CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  contact_list_id CHAR(36) CHARACTER SET ascii NULL,
  external_id     VARCHAR(200) NULL,
  first_name      VARCHAR(100) NULL,
  last_name       VARCHAR(100) NULL,
  phone_e164      VARCHAR(16) CHARACTER SET ascii NOT NULL,
  alt_phone_e164  VARCHAR(16) CHARACTER SET ascii NULL,
  email           VARCHAR(254) NULL,
  timezone        VARCHAR(64) NULL,
  country_code    CHAR(2) NULL,
  attributes      JSON NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  live            TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_contacts_tenant_id (tenant_id, id),
  UNIQUE KEY uq_contacts_external (tenant_id, external_id, live),
  KEY ix_contacts_phone (tenant_id, phone_e164),
  KEY ix_contacts_list (tenant_id, contact_list_id),
  CONSTRAINT fk_contacts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_contacts_list FOREIGN KEY (tenant_id, contact_list_id) REFERENCES contact_lists (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS dnc_entries (
  id          CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  phone_e164  VARCHAR(16) CHARACTER SET ascii NOT NULL,
  source      VARCHAR(16) NOT NULL,
  reason      VARCHAR(500) NULL,
  expires_at  DATETIME(3) NULL,
  created_by  CHAR(36) CHARACTER SET ascii NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_dnc_phone (tenant_id, phone_e164),
  CONSTRAINT fk_dnc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS consent_records (
  id           CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id    CHAR(36) CHARACTER SET ascii NOT NULL,
  contact_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  consent_type VARCHAR(32) NOT NULL,
  granted      TINYINT(1) NOT NULL,
  evidence     JSON NULL,
  captured_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at   DATETIME(3) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_consent_contact (tenant_id, contact_id, consent_type, captured_at),
  CONSTRAINT fk_consent_contact FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                        CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id                 CHAR(36) CHARACTER SET ascii NOT NULL,
  name                      VARCHAR(200) NOT NULL,
  dial_mode                 VARCHAR(16) NOT NULL,
  status                    VARCHAR(16) NOT NULL DEFAULT 'draft',
  queue_id                  CHAR(36) CHARACTER SET ascii NULL,
  ai_agent_id               CHAR(36) CHARACTER SET ascii NULL,
  caller_id_id              CHAR(36) CHARACTER SET ascii NULL,
  max_abandon_rate          DECIMAL(5,4) NOT NULL DEFAULT 0.0300,
  dial_ratio_max            DECIMAL(4,2) NOT NULL DEFAULT 2.00,
  max_concurrent_calls      INT NOT NULL DEFAULT 10,
  max_attempts              INT NOT NULL DEFAULT 3,
  retry_delay_minutes       INT NOT NULL DEFAULT 60,
  ring_timeout_seconds      INT NOT NULL DEFAULT 25,
  calling_window_start      TIME NOT NULL DEFAULT '09:00:00',
  calling_window_end        TIME NOT NULL DEFAULT '21:00:00',
  allowed_days              JSON NULL,            -- ISO weekday numbers, default [1..6] applied by API
  recording_enabled         TINYINT(1) NOT NULL DEFAULT 1,
  legal_review_confirmed_at DATETIME(3) NULL,     -- required before predictive/ai campaigns may start
  starts_at                 DATETIME(3) NULL,
  ends_at                   DATETIME(3) NULL,
  settings                  JSON NULL,
  created_by                CHAR(36) CHARACTER SET ascii NULL,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at                DATETIME(3) NULL,
  UNIQUE KEY uq_campaigns_tenant_id (tenant_id, id),
  KEY ix_campaigns_status (tenant_id, status),
  CONSTRAINT fk_campaigns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_campaigns_queue FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id),
  CONSTRAINT fk_campaigns_caller_id FOREIGN KEY (tenant_id, caller_id_id) REFERENCES caller_ids (tenant_id, id),
  CONSTRAINT fk_campaigns_creator FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  campaign_id          CHAR(36) CHARACTER SET ascii NOT NULL,
  contact_id           CHAR(36) CHARACTER SET ascii NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts             INT NOT NULL DEFAULT 0,
  priority             INT NOT NULL DEFAULT 0,
  next_attempt_at      DATETIME(3) NULL,
  last_attempt_at      DATETIME(3) NULL,
  last_call_session_id CHAR(36) CHARACTER SET ascii NULL,
  disposition_id       CHAR(36) CHARACTER SET ascii NULL,
  locked_by            VARCHAR(100) NULL,
  locked_until         DATETIME(3) NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cc_tenant_id (tenant_id, id),
  UNIQUE KEY uq_cc_campaign_contact (campaign_id, contact_id),
  KEY ix_cc_next (tenant_id, campaign_id, status, next_attempt_at, priority),
  CONSTRAINT fk_cc_campaign FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_cc_contact FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_cc_disposition FOREIGN KEY (tenant_id, disposition_id) REFERENCES call_dispositions (tenant_id, id)
);
