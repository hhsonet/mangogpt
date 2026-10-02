-- Fast "contains" search (ILIKE '%term%') over chat titles and message text.
-- Without these indexes PostgreSQL scans every message a user owns on each search.
-- Index builds can take a while on big tables, so lift the statement timeout for this migration.
SET statement_timeout = 0;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Message_content_trgm_idx" ON "Message" USING GIN ("content" gin_trgm_ops);
CREATE INDEX "Conversation_title_trgm_idx" ON "Conversation" USING GIN ("title" gin_trgm_ops);

RESET statement_timeout;
