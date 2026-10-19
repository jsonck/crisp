-- WHY a reply was sent to the customer rather than drafted as a note.
--
--   autonomous_topic -> every topic it drew on is marked autonomous
--   nobody_online    -> no operator was on shift, so a note would have sat
--                       unread; the transcripts show that costing hours
--
-- Worth separating because the two carry different risk. An autonomous topic
-- was deliberately promoted after review; "nobody online" applies to ANY
-- covered answer, which is a much wider surface. If the bot ever says something
-- wrong to a customer, this column is the first thing to group by.
alter table bot_suggestions add column send_reason text
  check (send_reason in ('autonomous_topic', 'nobody_online'));

create index bot_suggestions_send_reason_idx on bot_suggestions (send_reason, created_at desc)
  where send_reason is not null;
