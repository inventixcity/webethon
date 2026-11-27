-- Admin record history and the audit `target` filter look up rows by (target_type, target_id), newest first.
-- Without this, every history read scans the whole audit log.
create index audit_log_target_idx on audit_log (target_type, target_id, at desc);
