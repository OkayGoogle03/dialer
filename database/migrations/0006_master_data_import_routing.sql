-- 0006: master data (providers, DIDs, processes, call servers, assignments), caller import, outbound routing.
-- Modelling decisions (docs/decisions.md D-027..D-033):
--  * "SIP trunk" = existing tenant_sip_providers table (extended below); "service provider" = new business entity above it.
--  * provider_dids is the DID master. The older caller_ids table stays for campaigns and is not touched.
--  * Technical fields on call_servers are nullable: an Excel import may create a server with NO invented connection details.

-- ---------------------------------------------------------------- permissions
INSERT IGNORE INTO permissions (`key`, description) VALUES
  ('master_data:read', 'View providers, trunks, DIDs, processes and call servers'),
  ('processes:manage', 'Manage outbound processes and their assignments'),
  ('call_servers:manage', 'Manage call servers'),
  ('caller_import:manage', 'Upload and import caller assignments from Excel');

-- Backfill existing tenants' system roles (new tenants get these from SYSTEM_ROLES in code).
INSERT IGNORE INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, p.`key` FROM roles r JOIN permissions p
   WHERE r.`key` = 'tenant_admin' AND r.is_system = 1
     AND p.`key` IN ('master_data:read', 'processes:manage', 'call_servers:manage', 'caller_import:manage');

INSERT IGNORE INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, p.`key` FROM roles r JOIN permissions p
   WHERE r.`key` = 'supervisor' AND r.is_system = 1
     AND p.`key` IN ('master_data:read', 'caller_import:manage');

INSERT IGNORE INTO role_permissions (tenant_id, role_id, permission_key)
  SELECT r.tenant_id, r.id, 'master_data:read' FROM roles r
   WHERE r.`key` = 'team_leader' AND r.is_system = 1;

-- ---------------------------------------------------------------- service providers
CREATE TABLE IF NOT EXISTS service_providers (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  name                 VARCHAR(100) COLLATE utf8mb4_general_ci NOT NULL,
  description          VARCHAR(500) NULL,
  status               VARCHAR(24) NOT NULL DEFAULT 'pending_configuration',
  priority             INT NOT NULL DEFAULT 100,
  weight               INT NOT NULL DEFAULT 100,
  max_concurrent_calls INT NOT NULL DEFAULT 30,
  retry_policy         JSON NULL,
  created_by           CHAR(36) CHARACTER SET ascii NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at           DATETIME(3) NULL,
  live                 TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_sp_tenant_id (tenant_id, id),
  UNIQUE KEY uq_sp_name (tenant_id, name, live),
  CONSTRAINT fk_sp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

-- Extend the existing trunk table.
ALTER TABLE tenant_sip_providers
  ADD COLUMN service_provider_id CHAR(36) CHARACTER SET ascii NULL,
  ADD COLUMN auth_id VARCHAR(200) NULL,
  ADD COLUMN realm VARCHAR(253) NULL,
  ADD COLUMN outbound_proxy VARCHAR(253) NULL,
  ADD COLUMN registration_expiry_seconds INT NOT NULL DEFAULT 300,
  ADD COLUMN codecs JSON NULL,
  ADD COLUMN rtp_config JSON NULL,
  ADD COLUMN registration_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN verification_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN verified_at DATETIME(3) NULL,
  ADD COLUMN last_test_error VARCHAR(500) NULL;

ALTER TABLE tenant_sip_providers
  ADD CONSTRAINT fk_tsp_service_provider FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id);

-- ---------------------------------------------------------------- call servers (Asterisk instances)
CREATE TABLE IF NOT EXISTS call_servers (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  name                 VARCHAR(100) COLLATE utf8mb4_general_ci NOT NULL,
  host                 VARCHAR(253) NULL,
  port                 INT NULL,
  instance_id          VARCHAR(100) NULL,
  ari_url              VARCHAR(500) NULL,
  ari_username         VARCHAR(100) NULL,
  ari_secret_encrypted TEXT NULL,
  environment          VARCHAR(16) NOT NULL DEFAULT 'production',
  connection_status    VARCHAR(16) NOT NULL DEFAULT 'unknown',
  connection_checked_at DATETIME(3) NULL,
  connection_error     VARCHAR(500) NULL,
  max_concurrent_calls INT NOT NULL DEFAULT 100,
  status               VARCHAR(24) NOT NULL DEFAULT 'pending_configuration',
  created_by           CHAR(36) CHARACTER SET ascii NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at           DATETIME(3) NULL,
  live                 TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_cs_tenant_id (tenant_id, id),
  UNIQUE KEY uq_cs_name (tenant_id, name, live),
  CONSTRAINT fk_cs2_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- DIDs
CREATE TABLE IF NOT EXISTS provider_dids (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  service_provider_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  trunk_id             CHAR(36) CHARACTER SET ascii NULL,
  did                  VARCHAR(20) CHARACTER SET ascii NOT NULL,
  caller_id            VARCHAR(20) CHARACTER SET ascii NULL,
  prefix               VARCHAR(8) CHARACTER SET ascii NULL,
  verification_status  VARCHAR(16) NOT NULL DEFAULT 'pending',
  verified_at          DATETIME(3) NULL,
  max_concurrent_calls INT NOT NULL DEFAULT 5,
  status               VARCHAR(24) NOT NULL DEFAULT 'pending_verification',
  created_by           CHAR(36) CHARACTER SET ascii NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at           DATETIME(3) NULL,
  live                 TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_pd_tenant_id (tenant_id, id),
  UNIQUE KEY uq_pd_did (tenant_id, did, live),
  KEY ix_pd_provider (tenant_id, service_provider_id),
  CONSTRAINT fk_pd_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_pd_provider FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  CONSTRAINT fk_pd_trunk FOREIGN KEY (tenant_id, trunk_id) REFERENCES tenant_sip_providers (tenant_id, id)
);

-- ---------------------------------------------------------------- outbound processes
CREATE TABLE IF NOT EXISTS outbound_processes (
  id                          CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id                   CHAR(36) CHARACTER SET ascii NOT NULL,
  name                        VARCHAR(100) COLLATE utf8mb4_general_ci NOT NULL,
  code                        VARCHAR(40) COLLATE utf8mb4_general_ci NOT NULL,
  description                 VARCHAR(500) NULL,
  default_service_provider_id CHAR(36) CHARACTER SET ascii NULL,
  routing_strategy            VARCHAR(16) NOT NULL DEFAULT 'priority',
  dial_plan                   JSON NULL,
  max_concurrent_calls        INT NOT NULL DEFAULT 50,
  status                      VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by                  CHAR(36) CHARACTER SET ascii NULL,
  created_at                  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at                  DATETIME(3) NULL,
  live                        TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_op_tenant_id (tenant_id, id),
  UNIQUE KEY uq_op_name (tenant_id, name, live),
  UNIQUE KEY uq_op_code (tenant_id, code, live),
  CONSTRAINT fk_op_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_op_default_provider FOREIGN KEY (tenant_id, default_service_provider_id) REFERENCES service_providers (tenant_id, id)
);

-- ---------------------------------------------------------------- process relationships
CREATE TABLE IF NOT EXISTS process_provider_assignments (
  tenant_id           CHAR(36) CHARACTER SET ascii NOT NULL,
  process_id          CHAR(36) CHARACTER SET ascii NOT NULL,
  service_provider_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (process_id, service_provider_id),
  KEY ix_ppa_provider (tenant_id, service_provider_id),
  CONSTRAINT fk_ppa_process FOREIGN KEY (tenant_id, process_id) REFERENCES outbound_processes (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_ppa_provider FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS process_did_assignments (
  tenant_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  process_id CHAR(36) CHARACTER SET ascii NOT NULL,
  did_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (process_id, did_id),
  KEY ix_pda_did (tenant_id, did_id),
  CONSTRAINT fk_pda_process FOREIGN KEY (tenant_id, process_id) REFERENCES outbound_processes (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_pda_did FOREIGN KEY (tenant_id, did_id) REFERENCES provider_dids (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS process_server_assignments (
  tenant_id      CHAR(36) CHARACTER SET ascii NOT NULL,
  process_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  call_server_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (process_id, call_server_id),
  KEY ix_psa_server (tenant_id, call_server_id),
  CONSTRAINT fk_psa_process FOREIGN KEY (tenant_id, process_id) REFERENCES outbound_processes (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_psa_server FOREIGN KEY (tenant_id, call_server_id) REFERENCES call_servers (tenant_id, id)
);

-- ---------------------------------------------------------------- caller import
CREATE TABLE IF NOT EXISTS caller_import_batches (
  id             CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id      CHAR(36) CHARACTER SET ascii NOT NULL,
  file_name      VARCHAR(255) NOT NULL,
  file_sha256    CHAR(64) CHARACTER SET ascii NOT NULL,
  mode           VARCHAR(16) NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'previewed',
  total_rows     INT NOT NULL DEFAULT 0,
  empty_rows     INT NOT NULL DEFAULT 0,
  imported_rows  INT NOT NULL DEFAULT 0,
  summary        JSON NULL,
  created_by     CHAR(36) CHARACTER SET ascii NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cib_tenant_id (tenant_id, id),
  KEY ix_cib_list (tenant_id, created_at),
  KEY ix_cib_hash (tenant_id, file_sha256),
  CONSTRAINT fk_cib_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS caller_import_records (
  id               CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  batch_id         CHAR(36) CHARACTER SET ascii NOT NULL,
  row_no           INT NOT NULL,
  process_name     VARCHAR(255) NULL,
  service_provider VARCHAR(255) NULL,
  did              VARCHAR(64) NULL,
  prefix           VARCHAR(32) NULL,
  call_server      VARCHAR(255) NULL,
  status           VARCHAR(24) NOT NULL,
  errors           JSON NULL,
  needs            JSON NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cir_row (batch_id, row_no),
  KEY ix_cir_status (tenant_id, batch_id, status),
  CONSTRAINT fk_cir_batch FOREIGN KEY (tenant_id, batch_id) REFERENCES caller_import_batches (tenant_id, id) ON DELETE CASCADE
);

-- Routing tuples used by the outbound dialer.
CREATE TABLE IF NOT EXISTS caller_assignments (
  id                  CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id           CHAR(36) CHARACTER SET ascii NOT NULL,
  process_id          CHAR(36) CHARACTER SET ascii NOT NULL,
  service_provider_id CHAR(36) CHARACTER SET ascii NOT NULL,
  did_id              CHAR(36) CHARACTER SET ascii NOT NULL,
  call_server_id      CHAR(36) CHARACTER SET ascii NOT NULL,
  prefix              VARCHAR(8) CHARACTER SET ascii NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'active',
  import_batch_id     CHAR(36) CHARACTER SET ascii NULL,
  created_by          CHAR(36) CHARACTER SET ascii NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ca_tenant_id (tenant_id, id),
  UNIQUE KEY uq_ca_tuple (tenant_id, process_id, service_provider_id, did_id, call_server_id),
  KEY ix_ca_process (tenant_id, process_id, status),
  KEY ix_ca_batch (tenant_id, import_batch_id),
  CONSTRAINT fk_ca_process FOREIGN KEY (tenant_id, process_id) REFERENCES outbound_processes (tenant_id, id),
  CONSTRAINT fk_ca_provider FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  CONSTRAINT fk_ca_did FOREIGN KEY (tenant_id, did_id) REFERENCES provider_dids (tenant_id, id),
  CONSTRAINT fk_ca_server FOREIGN KEY (tenant_id, call_server_id) REFERENCES call_servers (tenant_id, id),
  CONSTRAINT fk_ca_batch FOREIGN KEY (tenant_id, import_batch_id) REFERENCES caller_import_batches (tenant_id, id)
);

-- ---------------------------------------------------------------- outbound calls (routing decision + lifecycle + concurrency accounting)
CREATE TABLE IF NOT EXISTS outbound_calls (
  id                    CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id             CHAR(36) CHARACTER SET ascii NOT NULL,
  call_session_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  process_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  service_provider_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  trunk_id              CHAR(36) CHARACTER SET ascii NOT NULL,
  did_id                CHAR(36) CHARACTER SET ascii NOT NULL,
  call_server_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  caller_assignment_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  dialed_number         VARCHAR(32) CHARACTER SET ascii NOT NULL,
  caller_id             VARCHAR(20) CHARACTER SET ascii NULL,
  status                VARCHAR(16) NOT NULL DEFAULT 'initiated',
  attempt_no            INT NOT NULL DEFAULT 1,
  channel_id            VARCHAR(128) NULL,
  failure_code          VARCHAR(64) NULL,
  started_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at              DATETIME(3) NULL,
  created_by            CHAR(36) CHARACTER SET ascii NULL,
  UNIQUE KEY uq_oc_tenant_id (tenant_id, id),
  KEY ix_oc_started (tenant_id, started_at),
  KEY ix_oc_provider (tenant_id, service_provider_id, status),
  KEY ix_oc_trunk (tenant_id, trunk_id, status),
  KEY ix_oc_did (tenant_id, did_id, status),
  KEY ix_oc_server (tenant_id, call_server_id, status),
  KEY ix_oc_process (tenant_id, process_id, status),
  KEY ix_oc_session (tenant_id, call_session_id),
  CONSTRAINT fk_oc_session FOREIGN KEY (tenant_id, call_session_id) REFERENCES call_sessions (tenant_id, id),
  CONSTRAINT fk_oc_process FOREIGN KEY (tenant_id, process_id) REFERENCES outbound_processes (tenant_id, id),
  CONSTRAINT fk_oc_provider FOREIGN KEY (tenant_id, service_provider_id) REFERENCES service_providers (tenant_id, id),
  CONSTRAINT fk_oc_trunk FOREIGN KEY (tenant_id, trunk_id) REFERENCES tenant_sip_providers (tenant_id, id),
  CONSTRAINT fk_oc_did FOREIGN KEY (tenant_id, did_id) REFERENCES provider_dids (tenant_id, id),
  CONSTRAINT fk_oc_server FOREIGN KEY (tenant_id, call_server_id) REFERENCES call_servers (tenant_id, id),
  CONSTRAINT fk_oc_assignment FOREIGN KEY (tenant_id, caller_assignment_id) REFERENCES caller_assignments (tenant_id, id)
);

-- 'pending_configuration' (21 chars) does not fit the original VARCHAR(16) trunk status column.
ALTER TABLE tenant_sip_providers MODIFY COLUMN status VARCHAR(24) NOT NULL DEFAULT 'active';
