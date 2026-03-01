-- Add timezone support for user-local parsing/rendering
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'UTC+02:00';

-- Persistent anti-abuse ledger for trial access
CREATE TABLE IF NOT EXISTS "trial_ledgers" (
	"id" TEXT NOT NULL,
	"telegramId" TEXT NOT NULL,
	"firstUserId" TEXT,
	"stripeCustomerId" TEXT,
	"usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "trial_ledgers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "trial_ledgers_telegramId_key"
ON "trial_ledgers"("telegramId");

-- Align FK cascades for user hard-delete by SQL
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.table_constraints
		WHERE constraint_name = 'accounts_userId_fkey'
	) THEN
		ALTER TABLE "accounts" DROP CONSTRAINT "accounts_userId_fkey";
	END IF;
	ALTER TABLE "accounts"
	ADD CONSTRAINT "accounts_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM information_schema.table_constraints
		WHERE constraint_name = 'categories_userId_fkey'
	) THEN
		ALTER TABLE "categories" DROP CONSTRAINT "categories_userId_fkey";
	END IF;
	ALTER TABLE "categories"
	ADD CONSTRAINT "categories_userId_fkey"
	FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
