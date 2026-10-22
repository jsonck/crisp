-- Our own copy of the conversations.
--
-- Until now the only record of a conversation was `bot_suggestions`: one row
-- per INCOMING VISITOR MESSAGE, holding what the bot would have said. That is a
-- log of the bot's judgment, not of the conversation. It cannot see operator
-- replies, cannot see what the bot actually sent, and cannot see a conversation
-- the bot skipped — so "how many watermark removals did we handle today" had to
-- be answered by running ILIKE over first messages and hoping.
--
-- Crisp stays the system of record. Everything in `conversations` and
-- `conversation_messages` is a mirror of it and can be rebuilt from scratch by
-- the backfill (api/src/scripts/backfill.ts). Nothing of ours lives there.
--
-- What IS ours lives in `conversation_tags` and `daily_summaries`, precisely so
-- that rebuilding the mirror cannot destroy it.

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table conversations (
  session_id     text primary key,
  website_id     text not null,

  -- Which merchant this is, resolved the same way the bot resolves it (the
  -- api_key on the Crisp session). Null when the visitor was never identified,
  -- which is itself worth counting.
  api_key        text,
  nickname       text,
  email          text,

  -- Crisp's own state: pending / unresolved / resolved.
  state          text,

  started_at     timestamptz,
  last_at        timestamptz,
  msg_count      integer not null default 0,

  -- The opening visitor message, denormalised. Nearly every question about a
  -- conversation starts with "what did they come in asking", and keeping it
  -- here turns that into a column scan instead of a join to the first message.
  first_question text,

  -- True once the FULL history has been walked (the backfill, or the nightly
  -- sync). False means the row was written from a webhook, which only ever
  -- sees the most recent page of messages — so a long conversation may have a
  -- gap in the middle until something fills it in.
  complete       boolean not null default false,

  synced_at      timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

comment on table conversations is
  'One row per Crisp conversation. A mirror of Crisp, rebuildable from it —
   never put anything here that does not exist upstream.';

comment on column conversations.complete is
  'False when written from a webhook (last page of messages only). The nightly
   sync and the backfill set it true once the whole history has been walked.';

create index conversations_last_at_idx on conversations (last_at desc);
create index conversations_api_key_idx on conversations (api_key) where api_key is not null;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table conversation_messages (
  session_id  text not null references conversations (session_id) on delete cascade,

  -- Crisp's per-message id. Already the webhook's idempotency key, and here it
  -- makes the upsert naturally exactly-once: the same message can be written by
  -- a webhook, the nightly sync and the backfill without ever duplicating.
  fingerprint text not null,

  -- As Crisp reports it: 'user' is the visitor, 'operator' is our side.
  from_role   text not null check (from_role in ('user', 'operator', 'system')),

  -- Crisp's own origin string: 'chat' for a person typing, 'urn:crisp.im:*'
  -- for a plugin. Stored raw rather than collapsed into an is_bot boolean —
  -- "which integration said this" is a question we will have again, and the
  -- boolean is one `like 'urn:%'` away whenever it is wanted.
  origin      text,

  -- Private notes never reached the customer. Mixing them into reply counts
  -- would inflate every response metric, so they are flagged, not filtered —
  -- the bot's own suggestion notes are interesting in their own right.
  is_note     boolean not null default false,

  author      text,
  body        text not null,
  sent_at     timestamptz not null,

  primary key (session_id, fingerprint)
);

comment on table conversation_messages is
  'Every message of every mirrored conversation, visitor and operator alike.
   Upserted on (session_id, fingerprint), so re-syncing is always safe.';

create index conversation_messages_sent_at_idx on conversation_messages (sent_at desc);
create index conversation_messages_session_idx on conversation_messages (session_id, sent_at);

-- The point of the whole table: searching what was actually said, instead of
-- ILIKE over the first message of each conversation.
create index conversation_messages_fts_idx
  on conversation_messages using gin (to_tsvector('english', body));

-- ---------------------------------------------------------------------------
-- Tags — the half that is OURS
-- ---------------------------------------------------------------------------

create table conversation_tags (
  session_id text not null references conversations (session_id) on delete cascade,
  tag        text not null,

  -- 'human' -> somebody typed it; the last word, never overwritten by a re-run.
  -- 'model' -> the nightly analysis; safe to delete and recompute in bulk.
  -- 'kb'    -> topics_used from bot_suggestions; free, no inference needed.
  source     text not null check (source in ('human', 'model', 'kb')),

  -- Model tags only. Lets a low-confidence classification be excluded from a
  -- metric without being thrown away.
  confidence real,

  -- Why the model applied it ("customer threatened to churn"), or an editor's
  -- own note. Null for kb tags, which need no justification.
  note       text,

  tagged_by  text,
  tagged_at  timestamptz not null default now(),

  primary key (session_id, tag, source)
);

comment on table conversation_tags is
  'Labels on conversations. NOT derived from Crisp and NOT rebuildable — the
   reason tags live here rather than as a column on conversations, which the
   backfill is free to overwrite.';

comment on column conversation_tags.source is
  'Who applied it. The primary key includes it on purpose: a human and the
   model may both apply the same tag, and the human one must survive a bulk
   re-classification that deletes every model tag.';

create index conversation_tags_tag_idx on conversation_tags (tag, tagged_at desc);
create index conversation_tags_session_idx on conversation_tags (session_id);

-- ---------------------------------------------------------------------------
-- Daily summaries
-- ---------------------------------------------------------------------------

-- The nightly analysis already existed; it was rendered to an email and
-- discarded, so no two days could ever be compared. Same JSON, kept.
create table daily_summaries (
  summary_date date primary key,
  total_count  integer not null default 0,
  analysis     jsonb not null,
  emailed      boolean not null default false,
  created_at   timestamptz not null default now()
);

comment on table daily_summaries is
  'One row per day of the Crisp summary analysis. Ours, not Crisp''s: the model
   produced it and it exists nowhere else, so the backfill never touches it.';

-- ---------------------------------------------------------------------------
-- Metrics
-- ---------------------------------------------------------------------------

-- Conversations per tag per day. The trend line an email cannot give you.
-- security_invoker so the view runs as the caller and the tables' RLS still
-- applies. Without it a view is evaluated as its owner, and Supabase grants
-- every authenticated role select on public views — which would hand the whole
-- conversation history to anyone with a login.
create view conversation_tag_daily with (security_invoker = on) as
  select
    date_trunc('day', c.started_at)::date as day,
    t.tag,
    t.source,
    count(distinct c.session_id) as conversations
  from conversation_tags t
  join conversations c using (session_id)
  group by 1, 2, 3;

comment on view conversation_tag_daily is
  'Grouped by the conversation START date, not the tagging date — a backfill
   tagging six months at once must not land it all on today.';

-- Volume and shape of a day, independent of tags.
create view conversation_daily with (security_invoker = on) as
  select
    date_trunc('day', c.started_at)::date as day,
    count(*) as conversations,
    count(*) filter (where c.api_key is not null) as identified,
    sum(c.msg_count) as messages,
    count(*) filter (where c.state = 'resolved') as resolved
  from conversations c
  group by 1;

-- How long a visitor waited for a human. The metric the old email could never
-- produce, and the one most likely to justify letting the bot off the leash.
create view conversation_first_response with (security_invoker = on) as
  select
    m.session_id,
    date_trunc('day', min(m.sent_at) filter (where m.from_role = 'user'))::date as day,
    min(m.sent_at) filter (where m.from_role = 'user') as first_user_at,
    min(m.sent_at) filter (where m.from_role = 'operator' and not m.is_note) as first_reply_at,
    extract(epoch from
      min(m.sent_at) filter (where m.from_role = 'operator' and not m.is_note)
      - min(m.sent_at) filter (where m.from_role = 'user')
    ) as first_response_seconds
  from conversation_messages m
  group by m.session_id;

comment on view conversation_first_response is
  'Null first_reply_at means nobody ever answered. Negative seconds means the
   operator spoke first (an outbound conversation) — filter both out before
   averaging.';

-- ---------------------------------------------------------------------------
-- RLS. Written by the worker (service_role, bypasses RLS); editors read.
-- Tags are the one table an editor may WRITE, because tagging is the point.
-- ---------------------------------------------------------------------------

alter table conversations         enable row level security;
alter table conversation_messages enable row level security;
alter table conversation_tags     enable row level security;
alter table daily_summaries       enable row level security;

create policy conversations_read on conversations
  for select to authenticated using (is_kb_editor());

create policy conversation_messages_read on conversation_messages
  for select to authenticated using (is_kb_editor());

create policy daily_summaries_read on daily_summaries
  for select to authenticated using (is_kb_editor());

create policy conversation_tags_read on conversation_tags
  for select to authenticated using (is_kb_editor());

-- An editor may only ever write their OWN tags. Without the source check an
-- editor could add or delete model tags, and the next nightly re-classification
-- would silently undo their work.
create policy conversation_tags_write on conversation_tags
  for insert to authenticated with check (is_kb_editor() and source = 'human');

create policy conversation_tags_update on conversation_tags
  for update to authenticated
  using (is_kb_editor() and source = 'human')
  with check (is_kb_editor() and source = 'human');

create policy conversation_tags_delete on conversation_tags
  for delete to authenticated using (is_kb_editor() and source = 'human');

-- ---------------------------------------------------------------------------
-- Keeping msg_count honest
-- ---------------------------------------------------------------------------

-- Recounted from the table rather than incremented, because the same messages
-- are written repeatedly: a webhook upserts the last page on every turn, and
-- the nightly sync rewrites the whole conversation. Anything additive would
-- drift upwards forever. One statement per sync, not one per message.
create or replace function refresh_conversation_count(p_session_id text)
  returns void
  language sql
  security definer
  set search_path = public, pg_temp
as $$
  update conversations c
     set msg_count = (
           select count(*) from conversation_messages m
            where m.session_id = c.session_id
         )
   where c.session_id = p_session_id;
$$;

-- Only the worker (service_role) ever calls this; editors have no business
-- rewriting counts, and a security definer function is public by default.
revoke execute on function refresh_conversation_count(text) from public, anon, authenticated;
