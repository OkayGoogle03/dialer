-- 0005: plans, subscriptions, usage, invoices, transactional outbox, consumer idempotency, request idempotency.

CREATE TABLE IF NOT EXISTS plans (
  id                   CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  `key`                VARCHAR(50) CHARACTER SET ascii NOT NULL,
  name                 VARCHAR(100) NOT NULL,
  max_users            INT NOT NULL,
  max_concurrent_calls INT NOT NULL,
  max_ai_concurrent    INT NOT NULL DEFAULT 0,
  included_minutes     INT NOT NULL DEFAULT 0,
  price_cents_monthly  INT NOT NULL DEFAULT 0,
  currency             CHAR(3) NOT NULL DEFAULT 'USD',
  features             JSON NULL,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_plans_key (`key`)
);

INSERT IGNORE INTO plans (id, `key`, name, max_users, max_concurrent_calls, max_ai_concurrent) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'starter', 'Starter', 10, 10, 0),
  ('00000000-0000-4000-8000-0000000000a2', 'growth', 'Growth', 50, 50, 5),
  ('00000000-0000-4000-8000-0000000000a3', 'enterprise', 'Enterprise', 1000, 500, 100);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                        CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id                 CHAR(36) CHARACTER SET ascii NOT NULL,
  plan_id                   CHAR(36) CHARACTER SET ascii NOT NULL,
  status                    VARCHAR(16) NOT NULL DEFAULT 'active',
  is_current                TINYINT AS (IF(status IN ('trialing', 'active', 'past_due'), 1, NULL)) VIRTUAL,
  max_concurrent_calls      INT NULL,
  monthly_spend_limit_cents BIGINT NULL,
  billing_provider          VARCHAR(50) NULL,
  billing_customer_ref      VARCHAR(200) NULL,
  current_period_start      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  current_period_end        DATETIME(3) NULL,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_subscriptions_tenant_id (tenant_id, id),
  UNIQUE KEY uq_subscriptions_one_current (tenant_id, is_current),
  CONSTRAINT fk_subscriptions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans (id)
);

CREATE TABLE IF NOT EXISTS usage_records (
  id          CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  metric      VARCHAR(32) NOT NULL,
  quantity    BIGINT NOT NULL,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  source_type VARCHAR(32) NULL,
  source_id   CHAR(36) CHARACTER SET ascii NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_usage_source (tenant_id, metric, source_type, source_id),
  KEY ix_usage_period (tenant_id, metric, occurred_at),
  CONSTRAINT fk_usage_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoices (
  id              CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  subscription_id CHAR(36) CHARACTER SET ascii NULL,
  number          VARCHAR(50) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'draft',
  currency        CHAR(3) NOT NULL DEFAULT 'USD',
  subtotal_cents  BIGINT NOT NULL DEFAULT 0,
  tax_cents       BIGINT NOT NULL DEFAULT 0,
  total_cents     BIGINT NOT NULL DEFAULT 0,
  period_start    DATETIME(3) NOT NULL,
  period_end      DATETIME(3) NOT NULL,
  external_ref    VARCHAR(200) NULL,
  line_items      JSON NULL,
  issued_at       DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_invoices_number (tenant_id, number),
  CONSTRAINT fk_invoices_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoices_subscription FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions (tenant_id, id)
);

-- Transactional outbox. API user: INSERT only. Relay (platform/system user) leases, publishes, marks.
CREATE TABLE IF NOT EXISTS outbox_events (
  id             CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,   -- = event_id = Nats-Msg-Id
  tenant_id      CHAR(36) CHARACTER SET ascii NOT NULL,
  event_type     VARCHAR(64) NOT NULL,
  event_version  INT NOT NULL DEFAULT 1,
  subject        VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(100) NULL,
  producer       VARCHAR(64) NOT NULL,
  payload        JSON NOT NULL,                                    -- full envelope
  occurred_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at   DATETIME(3) NULL,
  pending        TINYINT AS (IF(published_at IS NULL, 1, NULL)) VIRTUAL,
  attempts       INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  locked_by      VARCHAR(100) NULL,
  locked_until   DATETIME(3) NULL,
  last_error     VARCHAR(1000) NULL,
  KEY ix_outbox_pending (pending, occurred_at),
  KEY ix_outbox_lock (locked_by),
  CONSTRAINT fk_outbox_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

-- Consumer-side idempotency: one row per (consumer, event) processed.
CREATE TABLE IF NOT EXISTS processed_events (
  consumer     VARCHAR(100) NOT NULL,
  event_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  processed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  `key`           VARCHAR(200) NOT NULL,
  request_hash    CHAR(64) CHARACTER SET ascii NOT NULL,
  response_status INT NULL,
  response_body   JSON NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (tenant_id, `key`),
  CONSTRAINT fk_idem_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);
