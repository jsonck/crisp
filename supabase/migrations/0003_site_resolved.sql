-- Did we manage to identify which store the conversation belongs to?
-- Null for rows written before store resolution existed. This is the metric that
-- says whether the api_key plumbing is actually working in production.
alter table bot_suggestions add column site_resolved boolean;
