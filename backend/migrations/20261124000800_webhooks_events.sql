-- Distinguish test deliveries for the per-hook test budget.
alter table webhook_deliveries add column is_test boolean not null default false;
create index webhook_deliveries_test_budget_idx on webhook_deliveries(webhook_id, created_at desc) where is_test;
