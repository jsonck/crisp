-- Observation mode. BOT_MUTED (api/src/webhook.ts) lets the whole pipeline run
-- — model call, lookups, draft, send decision — and then sends nothing: no
-- customer message, no note, no handoff, no account change.
--
-- Why that needs its own columns: without them a muted row is indistinguishable
-- from a row where the bot simply had nothing to send, and the one question
-- muted mode exists to answer is "what WOULD it have done". `reply_sent` stays
-- honest (false), so the would-be decision needs somewhere else to live.

alter table bot_suggestions add column muted boolean not null default false;

comment on column bot_suggestions.muted is
  'True when this turn ran under BOT_MUTED: a draft was produced and nothing
   left the server. Rows written before muting existed are false, which is
   correct — they were live.';

-- Same two values as send_reason, and deliberately a separate column: writing
-- the suppressed decision into send_reason would make "what did we actually say
-- to customers" unanswerable, which is the question that column was added for.
alter table bot_suggestions add column would_send_reason text
  check (would_send_reason in ('autonomous_topic', 'nobody_online'));

comment on column bot_suggestions.would_send_reason is
  'On a muted row, why the reply WOULD have gone to the customer. Null means it
   would have stayed an internal note. Always null on a live row — there,
   send_reason carries the real decision.';

-- The account changes muting refused. Distinct from actions_taken, which only
-- ever lists changes that really happened; a muted turn adds nothing there.
alter table bot_suggestions add column withheld_actions text[] not null default '{}';

comment on column bot_suggestions.withheld_actions is
  'Mutating tools the model called while muted, which were refused. "The bot
   wanted to remove branding 14 times this week" is the headline this answers.';

-- "What was the bot about to do, and how often" over a muting window.
create index bot_suggestions_muted_idx on bot_suggestions (created_at desc)
  where muted;
