-- Which tools the bot called, and which of them changed the merchant's account.
-- actions_taken is the audit question that matters: what did the bot DO, not
-- just what did it say. Pop Convert keeps its own SiteAction record too; this is
-- the conversation-side half.
alter table bot_suggestions add column tools_used text[] not null default '{}';
alter table bot_suggestions add column actions_taken text[] not null default '{}';

create index bot_suggestions_actions_idx on bot_suggestions (created_at desc)
  where cardinality(actions_taken) > 0;
