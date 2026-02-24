-- 1) Trial ledger (persists trial usage outside users lifecycle)
CREATE TABLE IF NOT EXISTS "trial_ledger" (
	"id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
	"telegram_id" TEXT NOT NULL UNIQUE,
	"first_user_id" TEXT,
	"stripe_customer_id" TEXT,
	"used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Backfill trial usage from existing users
INSERT INTO "trial_ledger" ("telegram_id", "first_user_id", "stripe_customer_id", "used_at")
SELECT u."telegramId", u."id", u."stripeCustomerId", COALESCE(u."createdAt", CURRENT_TIMESTAMP)
FROM "users" u
WHERE u."trialUsed" = true
ON CONFLICT ("telegram_id") DO NOTHING;

-- 2) Category FK in transactions
ALTER TABLE "transactions"
	ADD COLUMN IF NOT EXISTS "category_id" TEXT;

UPDATE "transactions" t
SET "category_id" = c."id"
FROM "categories" c
WHERE c."userId" = t."user_id"
	AND c."name" = t."category"
	AND t."category_id" IS NULL;

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM information_schema.table_constraints
		WHERE constraint_name = 'transactions_category_id_fkey'
	) THEN
		ALTER TABLE "transactions"
			ADD CONSTRAINT "transactions_category_id_fkey"
			FOREIGN KEY ("category_id") REFERENCES "categories"("id")
			ON DELETE SET NULL ON UPDATE CASCADE;
	END IF;
END $$;

CREATE INDEX IF NOT EXISTS "transactions_category_id_idx"
	ON "transactions"("category_id");

-- 3) Monetary fields from float -> numeric
ALTER TABLE "account_assets"
	ALTER COLUMN "amount" TYPE NUMERIC(36, 18) USING "amount"::numeric;

ALTER TABLE "transactions"
	ALTER COLUMN "amount" TYPE NUMERIC(36, 18) USING "amount"::numeric,
	ALTER COLUMN "trade_base_amount" TYPE NUMERIC(36, 18) USING "trade_base_amount"::numeric,
	ALTER COLUMN "trade_quote_amount" TYPE NUMERIC(36, 18) USING "trade_quote_amount"::numeric,
	ALTER COLUMN "execution_price" TYPE NUMERIC(36, 18) USING "execution_price"::numeric,
	ALTER COLUMN "convertedAmount" TYPE NUMERIC(36, 18) USING "convertedAmount"::numeric,
	ALTER COLUMN "amount_usd" TYPE NUMERIC(36, 18) USING "amount_usd"::numeric;

ALTER TABLE "alert_configs"
	ALTER COLUMN "threshold" TYPE NUMERIC(36, 18) USING "threshold"::numeric;

ALTER TABLE "subscriptions"
	ALTER COLUMN "amount" TYPE NUMERIC(18, 2) USING "amount"::numeric;

-- 4) Harden FK cascade policy for user deletion
ALTER TABLE "accounts" DROP CONSTRAINT IF EXISTS "accounts_userId_fkey";
ALTER TABLE "accounts"
	ADD CONSTRAINT "accounts_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_userId_fkey";
ALTER TABLE "categories"
	ADD CONSTRAINT "categories_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_accountId_fkey";
ALTER TABLE "transactions"
	ADD CONSTRAINT "transactions_accountId_fkey"
	FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_fromAccountId_fkey";
ALTER TABLE "transactions"
	ADD CONSTRAINT "transactions_fromAccountId_fkey"
	FOREIGN KEY ("fromAccountId") REFERENCES "accounts"("id")
	ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_toAccountId_fkey";
ALTER TABLE "transactions"
	ADD CONSTRAINT "transactions_toAccountId_fkey"
	FOREIGN KEY ("toAccountId") REFERENCES "accounts"("id")
	ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_tagId_fkey";
ALTER TABLE "transactions"
	ADD CONSTRAINT "transactions_tagId_fkey"
	FOREIGN KEY ("tagId") REFERENCES "tags"("id")
	ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_user_id_fkey";
ALTER TABLE "transactions"
	ADD CONSTRAINT "transactions_user_id_fkey"
	FOREIGN KEY ("user_id") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_assets" DROP CONSTRAINT IF EXISTS "account_assets_accountId_fkey";
ALTER TABLE "account_assets"
	ADD CONSTRAINT "account_assets_accountId_fkey"
	FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tags" DROP CONSTRAINT IF EXISTS "tags_userId_fkey";
ALTER TABLE "tags"
	ADD CONSTRAINT "tags_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_analytics_views" DROP CONSTRAINT IF EXISTS "saved_analytics_views_userId_fkey";
ALTER TABLE "saved_analytics_views"
	ADD CONSTRAINT "saved_analytics_views_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alert_configs" DROP CONSTRAINT IF EXISTS "alert_configs_userId_fkey";
ALTER TABLE "alert_configs"
	ADD CONSTRAINT "alert_configs_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_userId_fkey";
ALTER TABLE "subscriptions"
	ADD CONSTRAINT "subscriptions_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "premium_events" DROP CONSTRAINT IF EXISTS "premium_events_userId_fkey";
ALTER TABLE "premium_events"
	ADD CONSTRAINT "premium_events_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "llm_user_memories" DROP CONSTRAINT IF EXISTS "llm_user_memories_userId_fkey";
ALTER TABLE "llm_user_memories"
	ADD CONSTRAINT "llm_user_memories_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;
