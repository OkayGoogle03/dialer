-- 0008: Excel-driven call lists. One uploaded sheet = one list for one agent. Each row names the call server IP, the agent's SIP ID
-- (the password is NOT stored here: it goes encrypted into softphone_accounts), the dial prefix and the phone number to call.
-- Per-row results (status, reason, duration) are kept for the UI and the Excel export.

CREATE TABLE IF NOT EXISTS call_lists (
  id            CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  name          VARCHAR(150) NOT NULL,
  file_name     VARCHAR(255) NULL,
  user_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  total_rows    INT NOT NULL DEFAULT 0,
  invalid_rows  INT NOT NULL DEFAULT 0,
  created_by    CHAR(36) CHARACTER SET ascii NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cl_tenant_id (tenant_id, id),
  KEY ix_cl_user (tenant_id, user_id, created_at),
  CONSTRAINT fk_cl_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_user FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS call_list_items (
  id               CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id        CHAR(36) CHARACTER SET ascii NOT NULL,
  list_id          CHAR(36) CHARACTER SET ascii NOT NULL,
  row_no           INT NOT NULL,
  call_server_id   CHAR(36) CHARACTER SET ascii NULL,
  server_host      VARCHAR(253) NULL,
  sip_id           VARCHAR(64) NULL,
  prefix           VARCHAR(8) NULL,
  phone            VARCHAR(40) NULL,
  dialed           VARCHAR(40) NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending',
  result           VARCHAR(300) NULL,
  sip_code         INT NULL,
  call_session_id  CHAR(36) CHARACTER SET ascii NULL,
  attempts         INT NOT NULL DEFAULT 0,
  called_at        DATETIME(3) NULL,
  answered_at      DATETIME(3) NULL,
  ended_at         DATETIME(3) NULL,
  duration_seconds INT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cli_tenant_id (tenant_id, id),
  UNIQUE KEY uq_cli_row (tenant_id, list_id, row_no),
  KEY ix_cli_status (tenant_id, list_id, status),
  KEY ix_cli_session (tenant_id, call_session_id),
  CONSTRAINT fk_cli_list FOREIGN KEY (tenant_id, list_id) REFERENCES call_lists (tenant_id, id) ON DELETE CASCADE
);
