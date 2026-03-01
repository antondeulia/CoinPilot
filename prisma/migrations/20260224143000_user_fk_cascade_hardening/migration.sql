-- Phase 3: align all user-owned foreign keys to ON DELETE CASCADE.
-- Safe to run after previous migrations; explicit drop/add removes legacy FK modes.

ALTER TABLE "accounts"
DROP CONSTRAINT IF EXISTS "accounts_userId_fkey";
ALTER TABLE "accounts"
ADD CONSTRAINT "accounts_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transactions"
DROP CONSTRAINT IF EXISTS "transactions_user_id_fkey";
ALTER TABLE "transactions"
ADD CONSTRAINT "transactions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "categories"
DROP CONSTRAINT IF EXISTS "categories_userId_fkey";
ALTER TABLE "categories"
ADD CONSTRAINT "categories_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tags"
DROP CONSTRAINT IF EXISTS "tags_userId_fkey";
ALTER TABLE "tags"
ADD CONSTRAINT "tags_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_analytics_views"
DROP CONSTRAINT IF EXISTS "saved_analytics_views_userId_fkey";
ALTER TABLE "saved_analytics_views"
ADD CONSTRAINT "saved_analytics_views_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alert_configs"
DROP CONSTRAINT IF EXISTS "alert_configs_userId_fkey";
ALTER TABLE "alert_configs"
ADD CONSTRAINT "alert_configs_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriptions"
DROP CONSTRAINT IF EXISTS "subscriptions_userId_fkey";
ALTER TABLE "subscriptions"
ADD CONSTRAINT "subscriptions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "premium_events"
DROP CONSTRAINT IF EXISTS "premium_events_userId_fkey";
ALTER TABLE "premium_events"
ADD CONSTRAINT "premium_events_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
