-- What the bot would have said, for every incoming visitor message.
-- In private-note mode this is the whole point: misses are as informative as
-- hits, and a miss posts no note, so without this table they'd be invisible.

create table bot_suggestions (
  id            bigserial primary key,
  website_id    text not null,
  session_id    text not null,
  -- Crisp's per-message fingerprint. Webhooks retry, so this is the
  -- idempotency key: claimed before the model is called, never after.
  fingerprint   text not null unique,
  question      text not null,
  covered       boolean,
  answer        text,
  reason        text,
  topics_used   text[] not null default '{}',
  posted_note   boolean not null default false,
  skipped       text,
  usage         jsonb,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

comment on column bot_suggestions.skipped is
  'Why no answer was attempted (operator already handling it, non-text message,
   and so on). Null means it was answered.';

create index bot_suggestions_recent_idx on bot_suggestions (created_at desc);
create index bot_suggestions_session_idx on bot_suggestions (session_id, created_at desc);

-- Rows are written by the worker (service_role, which bypasses RLS). Editors
-- get read-only access; nobody else gets anything.
alter table bot_suggestions enable row level security;

create policy bot_suggestions_read on bot_suggestions
  for select to authenticated using (is_kb_editor());
