-- Per-conversation state for the branding-removal script.
--
-- The bot is otherwise stateless: each message is answered from the knowledge
-- base plus the last 10 turns. That is fine for one-shot questions and wrong
-- for a multi-step flow — "have I already asked them to confirm?" and "have I
-- already asked for a review?" cannot be inferred reliably from a transcript,
-- and getting them wrong means asking twice or removing before confirming.

create table watermark_flows (
  session_id        text primary key,
  website_id        text not null,
  -- The store URL we showed them, recorded so a later reader can see what was
  -- actually confirmed rather than guessing from the current session data.
  store_url         text,
  asked_confirm_at  timestamptz,
  removed_at        timestamptz,
  review_asked_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table watermark_flows is
  'One row per Crisp conversation that entered the branding-removal script.
   Written by the worker (service_role). The review gate lives in Pop Convert
   (Qualifier.qualify == "mango"); this table only records what WE have already
   said in THIS conversation, so nothing is said twice.';

comment on column watermark_flows.review_asked_at is
  'Set once a reply has asked for a review. The ask happens only after the
   removal is confirmed done — never as a condition of it.';

create index watermark_flows_recent_idx on watermark_flows (updated_at desc);

alter table watermark_flows enable row level security;

create policy watermark_flows_read on watermark_flows
  for select to authenticated using (is_kb_editor());
