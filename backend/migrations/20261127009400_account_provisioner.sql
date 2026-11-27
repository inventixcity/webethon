alter table users
  add column if not exists provisioned_by uuid references users(id) on delete set null,
  add column if not exists provisioned_for_exam uuid references exams(id) on delete set null;

create index if not exists users_provisioner_idx
  on users (provisioned_by, provisioned_for_exam)
  where provisioned_by is not null and provisioned_for_exam is not null;
