-- Knowledge base for the Crisp support bot.
-- Topics are "pages"; each holds an ordered list of Q&A pairs.
-- Access is limited to allowlisted editors; the worker reads via service_role.

-- ---------------------------------------------------------------------------
-- Editor allowlist
-- ---------------------------------------------------------------------------

create table kb_editors (
  email      text primary key,
  name       text,
  created_at timestamptz not null default now()
);

comment on table kb_editors is
  'Who may read/write the KB. Managed out-of-band (dashboard / service_role) so
   an editor cannot grant access to themselves or anyone else.';

create or replace function is_kb_editor()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from kb_editors
    where email = lower(auth.jwt() ->> 'email')
  );
$$;

-- ---------------------------------------------------------------------------
-- Topics
-- ---------------------------------------------------------------------------

create table topics (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text unique,
  applies_when text,
  enabled      boolean not null default false,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null
);

comment on column topics.applies_when is
  'Tells the model WHEN this topic is relevant. Surfaced in the UI as
   "when this topic applies", not as a generic description.';

create index topics_position_idx on topics (position, created_at);

-- ---------------------------------------------------------------------------
-- Q&A pairs
-- ---------------------------------------------------------------------------

create table qa_pairs (
  id         uuid primary key default gen_random_uuid(),
  topic_id   uuid not null references topics (id) on delete cascade,
  question   text not null,
  answer     text not null,
  enabled    boolean not null default false,
  position   integer not null default 0,
  tags       text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on column qa_pairs.enabled is
  'Defaults to false so a half-written answer can never reach a customer.
   Doubles as the per-answer kill switch.';

create index qa_pairs_topic_idx on qa_pairs (topic_id, position, created_at);

-- Only enabled rows under enabled topics are ever sent to the model; this
-- partial index keeps that lookup cheap as the KB grows.
create index qa_pairs_enabled_idx on qa_pairs (topic_id) where enabled;

-- ---------------------------------------------------------------------------
-- Stamp updated_at / updated_by
-- ---------------------------------------------------------------------------

create or replace function touch_row()
  returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();   -- null when written by the worker (service_role)
  return new;
end;
$$;

create trigger topics_touch
  before insert or update on topics
  for each row execute function touch_row();

create trigger qa_pairs_touch
  before insert or update on qa_pairs
  for each row execute function touch_row();

-- ---------------------------------------------------------------------------
-- History: every change to an answer is recoverable
-- ---------------------------------------------------------------------------

create table qa_pairs_history (
  id          bigserial primary key,
  qa_pair_id  uuid not null,
  topic_id    uuid,
  action      text not null check (action in ('update', 'delete')),
  question    text,
  answer      text,
  enabled     boolean,
  changed_at  timestamptz not null default now(),
  changed_by  uuid
);

comment on table qa_pairs_history is
  'Pre-change snapshot of a qa_pair. Answers the "why is the bot saying that?"
   question after the fact.';

create index qa_pairs_history_pair_idx on qa_pairs_history (qa_pair_id, changed_at desc);

create or replace function record_qa_history()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  -- Skip no-op updates so the history stays readable.
  if tg_op = 'UPDATE'
     and old.question is not distinct from new.question
     and old.answer   is not distinct from new.answer
     and old.enabled  is not distinct from new.enabled then
    return new;
  end if;

  insert into qa_pairs_history
    (qa_pair_id, topic_id, action, question, answer, enabled, changed_by)
  values
    (old.id, old.topic_id, lower(tg_op), old.question, old.answer, old.enabled, auth.uid());

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger qa_pairs_history_trg
  after update or delete on qa_pairs
  for each row execute function record_qa_history();

-- ---------------------------------------------------------------------------
-- RLS: allowlisted editors only. No public access, unlike `snapshots`.
-- service_role (the worker) bypasses RLS by design.
-- ---------------------------------------------------------------------------

alter table kb_editors       enable row level security;
alter table topics           enable row level security;
alter table qa_pairs         enable row level security;
alter table qa_pairs_history enable row level security;

-- Editors can see the roster, but cannot change it.
create policy kb_editors_read on kb_editors
  for select to authenticated using (is_kb_editor());

create policy topics_all on topics
  for all to authenticated using (is_kb_editor()) with check (is_kb_editor());

create policy qa_pairs_all on qa_pairs
  for all to authenticated using (is_kb_editor()) with check (is_kb_editor());

-- History is append-only, written by the trigger; editors may read it.
create policy qa_pairs_history_read on qa_pairs_history
  for select to authenticated using (is_kb_editor());
