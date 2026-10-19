-- Handing a conversation to a human, and saying so to the customer.
--
-- Until now a not-covered message produced nothing at all: no note, no reply,
-- no assignment. The customer waited and nobody was told. These columns record
-- what the bot did about that instead.

-- Who the conversation was handed to. Null when nobody eligible was reachable,
-- or when the message needed no human (newsletters, spam).
alter table bot_suggestions add column handoff_to text;

-- Did the customer actually get told? The one customer-visible message the bot
-- sends today, so it is worth knowing separately from the internal note.
alter table bot_suggestions add column handoff_sent boolean not null default false;

-- The model's own read on whether a person is waiting. False for inbound
-- marketing and automated noise; those must not land in an operator's queue.
alter table bot_suggestions add column needs_human boolean;

-- Was this conversation already owned by someone when the bot got to it? Crisp
-- auto-assigns, so this is usually true, and it is why the bot must not
-- reassign on top: that would quietly steal tickets from whoever had them.
alter table bot_suggestions add column was_assigned boolean;

comment on column bot_suggestions.handoff_to is
  'Crisp operator user_id the bot assigned or mentioned. Names are resolved at
   read time via the Crisp API; storing the id keeps a rename from rewriting
   history.';

-- "Who is the bot leaning on, and is it spread evenly?" — the question this
-- table will be asked once handoffs are routine.
create index bot_suggestions_handoff_idx on bot_suggestions (handoff_to, created_at desc)
  where handoff_to is not null;
