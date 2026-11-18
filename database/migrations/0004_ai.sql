-- 0004: knowledge bases, AI agents, tools, sessions, transcripts.

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id              CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  name            VARCHAR(200) NOT NULL,
  description     TEXT NULL,
  embedding_model VARCHAR(100) NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  UNIQUE KEY uq_kb_tenant_id (tenant_id, id),
  CONSTRAINT fk_kb_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

-- Vector chunks: TODO Phase 5 (TiDB VECTOR type + vector index).
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id         CHAR(36) CHARACTER SET ascii NOT NULL,
  knowledge_base_id CHAR(36) CHARACTER SET ascii NOT NULL,
  title             VARCHAR(300) NOT NULL,
  storage_key       VARCHAR(512) NULL,
  mime_type         VARCHAR(100) NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at        DATETIME(3) NULL,
  UNIQUE KEY uq_kd_tenant_id (tenant_id, id),
  CONSTRAINT fk_kd_kb FOREIGN KEY (tenant_id, knowledge_base_id) REFERENCES knowledge_bases (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_agents (
  id                 CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id          CHAR(36) CHARACTER SET ascii NOT NULL,
  name               VARCHAR(200) NOT NULL,
  kind               VARCHAR(16) NOT NULL,
  system_prompt      TEXT NOT NULL,
  -- Mandatory AI disclosure, spoken first on autonomous calls. API rejects empty values.
  disclosure_message VARCHAR(500) NOT NULL DEFAULT 'Hello, this is an automated AI assistant calling on behalf of {company}.',
  languages          JSON NULL,
  stt_provider       VARCHAR(50) NOT NULL DEFAULT 'deepgram',
  stt_config         JSON NULL,
  llm_provider       VARCHAR(50) NOT NULL DEFAULT 'anthropic',
  llm_config         JSON NULL,
  tts_provider       VARCHAR(50) NOT NULL DEFAULT 'elevenlabs',
  tts_config         JSON NULL,
  knowledge_base_id  CHAR(36) CHARACTER SET ascii NULL,
  handoff_queue_id   CHAR(36) CHARACTER SET ascii NULL,
  max_call_seconds   INT NOT NULL DEFAULT 600,
  silence_timeout_ms INT NOT NULL DEFAULT 8000,
  status             VARCHAR(16) NOT NULL DEFAULT 'draft',
  version            INT NOT NULL DEFAULT 1,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3) NULL,
  UNIQUE KEY uq_ai_agents_tenant_id (tenant_id, id),
  CONSTRAINT fk_ai_agents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_agents_kb FOREIGN KEY (tenant_id, knowledge_base_id) REFERENCES knowledge_bases (tenant_id, id),
  CONSTRAINT fk_ai_agents_queue FOREIGN KEY (tenant_id, handoff_queue_id) REFERENCES queues (tenant_id, id)
);

ALTER TABLE campaigns ADD CONSTRAINT fk_campaigns_ai_agent FOREIGN KEY (tenant_id, ai_agent_id) REFERENCES ai_agents (tenant_id, id);

CREATE TABLE IF NOT EXISTS ai_tools (
  id                    CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id             CHAR(36) CHARACTER SET ascii NOT NULL,
  name                  VARCHAR(64) CHARACTER SET ascii NOT NULL,
  description           TEXT NOT NULL,
  input_schema          JSON NOT NULL,
  kind                  VARCHAR(16) NOT NULL,
  endpoint_url          VARCHAR(1000) NULL,
  secret_encrypted      TEXT NULL,
  requires_confirmation TINYINT(1) NOT NULL DEFAULT 0,
  timeout_ms            INT NOT NULL DEFAULT 5000,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at            DATETIME(3) NULL,
  live                  TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
  UNIQUE KEY uq_ai_tools_tenant_id (tenant_id, id),
  UNIQUE KEY uq_ai_tools_name (tenant_id, name, live),
  CONSTRAINT fk_ai_tools_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_agent_tools (
  tenant_id   CHAR(36) CHARACTER SET ascii NOT NULL,
  ai_agent_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ai_tool_id  CHAR(36) CHARACTER SET ascii NOT NULL,
  PRIMARY KEY (ai_agent_id, ai_tool_id),
  CONSTRAINT fk_aat_agent FOREIGN KEY (tenant_id, ai_agent_id) REFERENCES ai_agents (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_aat_tool FOREIGN KEY (tenant_id, ai_tool_id) REFERENCES ai_tools (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id              CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id       CHAR(36) CHARACTER SET ascii NOT NULL,
  ai_agent_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  call_session_id CHAR(36) CHARACTER SET ascii NULL,
  mode            VARCHAR(16) NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  outcome         VARCHAR(100) NULL,
  summary         TEXT NULL,
  extracted_data  JSON NULL,
  metrics         JSON NULL,
  started_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at        DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ai_sessions_tenant_id (tenant_id, id),
  KEY ix_ai_sessions_call (tenant_id, call_session_id),
  KEY ix_ai_sessions_agent (tenant_id, ai_agent_id, started_at),
  CONSTRAINT fk_ais_agent FOREIGN KEY (tenant_id, ai_agent_id) REFERENCES ai_agents (tenant_id, id),
  CONSTRAINT fk_ais_call FOREIGN KEY (tenant_id, call_session_id) REFERENCES call_sessions (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ai_transcripts (
  id            CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  tenant_id     CHAR(36) CHARACTER SET ascii NOT NULL,
  ai_session_id CHAR(36) CHARACTER SET ascii NOT NULL,
  seq           INT NOT NULL,
  speaker       VARCHAR(16) NOT NULL,
  text          TEXT NOT NULL,
  is_final      TINYINT(1) NOT NULL DEFAULT 1,
  start_ms      INT NULL,
  end_ms        INT NULL,
  confidence    FLOAT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ai_transcripts_seq (ai_session_id, seq),
  KEY ix_ai_transcripts_tenant (tenant_id, ai_session_id),
  CONSTRAINT fk_ait_session FOREIGN KEY (tenant_id, ai_session_id) REFERENCES ai_sessions (tenant_id, id) ON DELETE CASCADE
);
