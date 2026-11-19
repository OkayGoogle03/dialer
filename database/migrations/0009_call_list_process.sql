-- 0009: optional "Process Name" column of the Excel call list, kept per row (label shown in the UI and the Excel export).
ALTER TABLE call_list_items ADD COLUMN process_name VARCHAR(100) NULL;
