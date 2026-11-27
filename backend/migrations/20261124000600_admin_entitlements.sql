alter table entitlements
  add column admin_override_status text check (admin_override_status in ('active', 'revoked')),
  add column admin_override_expires_at timestamptz,
  add constraint entitlements_override_expiry_check check (admin_override_status = 'active' or admin_override_expires_at is null);
create index purchases_admin_order_idx on purchases (created_at desc, id desc);
create index entitlements_admin_order_idx on entitlements (created_at desc, user_id desc, product_id desc);
