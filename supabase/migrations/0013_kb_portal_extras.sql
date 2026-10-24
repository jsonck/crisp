-- Everything the merchant-facing knowledge base portal needs, and nothing the
-- bot does. The portal (ppc /help-center) renders the same Q&As the bot answers
-- from, but a merchant reading an answer wants two things a chat reply cannot
-- give them: a button that takes them to the exact page being described, and a
-- picture of what they are looking for.
--
-- These live on qa_pairs rather than in a side table because they are part of
-- the answer, edited with it and deleted with it. `api/src/kb.ts` selects its
-- columns explicitly, so the bot's prompt is byte-identical before and after
-- this migration - which matters, because that prompt is cached.

alter table qa_pairs
  add column links jsonb not null default '[]'::jsonb,
  add column media jsonb not null default '[]'::jsonb;

comment on column qa_pairs.links is
  'Ordered array of destinations for this answer, rendered as buttons in the
   portal. Each: {label, kind, to}. kind "app" is a path inside Pop Convert
   ("/campaigns") routed by vue-router; "admin" is a path under the merchant''s
   own Shopify admin ("discounts"), resolved against their shop handle at render
   time because it differs per store; "external" is an absolute URL.
   Empty array means the answer has nowhere specific to send them.';

comment on column qa_pairs.media is
  'Ordered array of images for this answer: {src, alt, caption, width, height}.
   src is either an absolute URL (the kb-media bucket) or an app-relative path
   the portal already ships ("/img/wheel-top.png"). width/height are stored so
   the portal can reserve the space and not reflow as images load.
   Empty array is the norm - most answers read better without a picture.';

-- A check that the shapes stay honest. Cheap, and it catches the editor saving
-- a bare string or an object instead of an array, which would otherwise only
-- surface as a broken portal page.
alter table qa_pairs
  add constraint qa_pairs_links_is_array check (jsonb_typeof(links) = 'array'),
  add constraint qa_pairs_media_is_array check (jsonb_typeof(media) = 'array');
