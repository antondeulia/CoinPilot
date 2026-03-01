-- Dual-write step for category FK (snapshot category string remains)
ALTER TABLE "transactions"
ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

CREATE INDEX IF NOT EXISTS "transactions_categoryId_idx"
ON "transactions"("categoryId");

UPDATE "transactions" t
SET "categoryId" = c."id"
FROM "categories" c
WHERE t."categoryId" IS NULL
	AND t."category" IS NOT NULL
	AND c."userId" = t."user_id"
	AND c."name" = t."category";

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM information_schema.table_constraints
		WHERE constraint_name = 'transactions_categoryId_fkey'
	) THEN
		ALTER TABLE "transactions"
		ADD CONSTRAINT "transactions_categoryId_fkey"
		FOREIGN KEY ("categoryId") REFERENCES "categories"("id")
		ON DELETE SET NULL ON UPDATE CASCADE;
	END IF;
END $$;
