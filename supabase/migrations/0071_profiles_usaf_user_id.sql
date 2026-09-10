-- The athlete key the app is moving to: the USA Fencing user id. Applied 2026-09-10.
alter table profiles add column if not exists usaf_user_id integer;
create index if not exists profiles_usaf_user on profiles (usaf_user_id);
