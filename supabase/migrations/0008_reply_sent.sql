-- Did this answer actually reach the customer, or was it only a suggestion?
-- With per-topic autonomy both now happen, and telling them apart is the whole
-- audit question: "what did we SAY to people" versus "what did we draft".
alter table bot_suggestions add column reply_sent boolean not null default false;

create index bot_suggestions_sent_idx on bot_suggestions (created_at desc)
  where reply_sent;
