-- 0013: per call server choice whether an unanswered outgoing call is cut automatically, and after how long.
-- auto_cut_enabled = 1 keeps the earlier behaviour; auto_cut_seconds NULL means the system default (RING_TIMEOUT_SECONDS).
ALTER TABLE call_servers ADD COLUMN auto_cut_enabled TINYINT NOT NULL DEFAULT 1, ADD COLUMN auto_cut_seconds INT NULL;
