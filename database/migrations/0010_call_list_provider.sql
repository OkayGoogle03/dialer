-- 0010: optional "Service Provider" column of the Excel call list, kept per row (label shown in the UI and the Excel export).
ALTER TABLE call_list_items ADD COLUMN service_provider VARCHAR(100) NULL;
