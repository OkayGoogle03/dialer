-- 0011: soft delete everywhere a user can delete a record.
-- record_status: 1 = active, 0 = deleted (the row stays in the table; the API only reads record_status = 1).
--
-- A) Tables that were hard-deleted until now get a real column (and a deleted_at timestamp):
ALTER TABLE call_lists ADD COLUMN record_status TINYINT NOT NULL DEFAULT 1, ADD COLUMN deleted_at DATETIME(3) NULL;
ALTER TABLE call_list_items ADD COLUMN record_status TINYINT NOT NULL DEFAULT 1, ADD COLUMN deleted_at DATETIME(3) NULL;
ALTER TABLE roles ADD COLUMN record_status TINYINT NOT NULL DEFAULT 1, ADD COLUMN deleted_at DATETIME(3) NULL;
ALTER TABLE roles ADD COLUMN live TINYINT AS (IF(record_status = 1, 1, NULL)) VIRTUAL;
-- a deleted role no longer blocks re-using its key
ALTER TABLE roles DROP INDEX uq_roles_tenant_key;
ALTER TABLE roles ADD UNIQUE KEY uq_roles_tenant_key (tenant_id, `key`, live);

-- B) Tables that already soft-delete through deleted_at expose the same 0/1 column, always in step with deleted_at:
ALTER TABLE users ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE teams ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE call_servers ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE softphone_accounts ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE outbound_processes ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE service_providers ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE provider_dids ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
ALTER TABLE tenant_sip_providers ADD COLUMN record_status TINYINT AS (IF(deleted_at IS NULL, 1, 0)) VIRTUAL;
