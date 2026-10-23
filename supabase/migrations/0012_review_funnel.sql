-- The review ask, end to end.
--
-- Today the only record of whether a merchant was asked for a review — and
-- what they said — is the transcript. watermark_flows.review_asked_at tracks
-- it for the BOT, and the bot is muted, so every ask in the last weeks was an
-- operator typing it by hand and is invisible to every table we have.
--
-- Two halves, deliberately kept apart:
--   * what was SAID  -> conversation_tags, written by the nightly analysis
--   * what is TRUE   -> these columns, from Pop Convert via the Crisp session
--
-- The model can read intent off a transcript ("sure, send the link") and
-- nothing more. Whether a review was actually posted is a fact Pop Convert
-- already knows, and the gap between the two is the only interesting number
-- here — "they said yes" is cheap.

-- ---------------------------------------------------------------------------
-- Ground truth, from the Crisp session payload we already fetch
-- ---------------------------------------------------------------------------

alter table conversations add column has_reviewed boolean;
alter table conversations add column qualification text;

comment on column conversations.has_reviewed is
  'Pop Convert''s own flag, pushed into Crisp session data, AS OF synced_at —
   not as of now. A merchant who reviews after their last sync still reads
   false here, so this undercounts rather than overcounts. Treat it as a floor
   on reviews, never as a settled per-merchant answer.';

comment on column conversations.qualification is
  'Pop Convert''s review gate. "mango" means eligible and has not reviewed;
   every other value is a colour meaning do not ask. It is therefore also a
   denominator: who it was ever legitimate to ask.';

create index conversations_qualification_idx on conversations (qualification)
  where qualification is not null;

-- ---------------------------------------------------------------------------
-- The funnel
-- ---------------------------------------------------------------------------

-- One row per conversation with its stage flags, so the funnel can be sliced
-- by day, by tag, or by anything else without re-deriving what a stage means.
-- Stages are columns rather than rows because they are not exclusive: a
-- conversation that was asked and agreed is counted at both steps, which is
-- what makes it a funnel rather than a breakdown.
create view review_funnel_conversations with (security_invoker = on) as
  select
    c.session_id,
    (c.started_at at time zone 'America/New_York')::date as day,
    c.nickname,
    c.api_key,
    c.qualification,
    c.has_reviewed,
    c.qualification = 'mango' as eligible,
    exists (
      select 1 from conversation_tags t
       where t.session_id = c.session_id and t.tag = 'review-asked'
    ) as asked,
    exists (
      select 1 from conversation_tags t
       where t.session_id = c.session_id and t.tag = 'review-agreed'
    ) as agreed,
    exists (
      select 1 from conversation_tags t
       where t.session_id = c.session_id and t.tag = 'review-claimed'
    ) as claimed,
    exists (
      select 1 from conversation_tags t
       where t.session_id = c.session_id and t.tag = 'review-declined'
    ) as declined
  from conversations c;

comment on view review_funnel_conversations is
  'Per-conversation stage flags for the review ask. Stages overlap on purpose —
   asked implies nothing was reset, so agreed rows are also asked rows.';

-- The counts, by day. Deliberately not pre-collapsed to a single total: a
-- funnel without a time axis cannot show that a change in the ask helped.
create view review_funnel_daily with (security_invoker = on) as
  select
    day,
    count(*) as conversations,
    count(*) filter (where eligible) as eligible,
    count(*) filter (where asked) as asked,
    count(*) filter (where agreed) as agreed,
    count(*) filter (where claimed) as claimed,
    count(*) filter (where declined) as declined,
    count(*) filter (where has_reviewed) as reviewed,
    -- How many conversations we actually hold the Crisp session facts for.
    -- Without this a stage reads zero both when nobody qualified and when we
    -- simply have not collected it yet, and those mean opposite things.
    count(qualification) as qualification_known,
    count(has_reviewed) as reviewed_known
  from review_funnel_conversations
  group by day;

comment on view review_funnel_daily is
  'The review funnel per day. `reviewed` is a floor, not a count of reviews
   earned that day — see conversations.has_reviewed.';
