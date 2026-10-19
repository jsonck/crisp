-- Per-topic permission to actually talk to the customer.
--
-- Until now every answer was a private note for an operator to send. That is
-- the right default and it stays the default: `autonomous` is false unless
-- somebody deliberately turns it on for one topic, after reading how that
-- topic's answers have been performing.
--
-- A reply is sent for real only when EVERY topic it drew on is autonomous, so
-- an answer that blends a trusted topic with an untrusted one stays a note.

alter table topics add column autonomous boolean not null default false;

comment on column topics.autonomous is
  'When true, answers drawn solely from this topic are sent to the customer
   instead of being posted as a suggested note. Off by default; promote a topic
   only once its drafts have proven right. This is the per-topic kill switch —
   flipping it back off stops customer-facing replies immediately.';
