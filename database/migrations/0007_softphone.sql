-- 0007: softphone model. Calls are placed by the agent's softphone, which registers with the call server (PBX) using the
-- agent's own SIP ID. The call server's address is admin-maintained because its IP is dynamic.
-- Existing call_servers.host / port are the SIP address (IP or DNS name) and port the softphone registers with.

ALTER TABLE call_servers
  ADD COLUMN sip_transport VARCHAR(8) NOT NULL DEFAULT 'wss',
  ADD COLUMN sip_ws_path VARCHAR(100) NOT NULL DEFAULT '/ws',
  ADD COLUMN sip_realm VARCHAR(253) NULL,
  ADD COLUMN address_updated_at DATETIME(3) NULL;

-- One SIP identity per (agent, call server). The password is AES-256-GCM encrypted and is only ever returned to that agent.
CREATE TABLE IF NOT EXISTS softphone_accounts (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id            CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id              CHAR(36) CHARACTER SET ascii NOT NULL,
  call_server_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  sip_id               VARCHAR(64) CHARACTER SET ascii NOT NULL,
  display_name         VARCHAR(100) NULL,
  sip_secret_encrypted TEXT NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'active',
  registration_status  VARCHAR(16) NOT NULL DEFAULT 'unknown',
  registered_at        DATETIME(3) NULL,
  last_seen_at         DATETIME(3) NULL,
  last_error           VARCHAR(300) NULL,
  created_by           CHAR(36) CHARACTER SET ascii NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at           DATETIME(3) NULL,
  live                 TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_spa_tenant_id (tenant_id, id),
  UNIQUE KEY uq_spa_user_server (tenant_id, user_id, call_server_id, live),
  UNIQUE KEY uq_spa_sip_id (tenant_id, call_server_id, sip_id, live),
  KEY ix_spa_server (tenant_id, call_server_id),
  CONSTRAINT fk_spa_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_spa_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT fk_spa_server FOREIGN KEY (tenant_id, call_server_id) REFERENCES call_servers (tenant_id, id)
);
