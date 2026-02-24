-- Phase 3: money dual-write columns (FLOAT -> NUMERIC/DECIMAL) with backfill.

ALTER TABLE "account_assets"
ADD COLUMN IF NOT EXISTS "amount_decimal" NUMERIC(38, 18);

ALTER TABLE "transactions"
ADD COLUMN IF NOT EXISTS "amount_decimal" NUMERIC(38, 18),
ADD COLUMN IF NOT EXISTS "converted_amount_decimal" NUMERIC(38, 18),
ADD COLUMN IF NOT EXISTS "amount_usd_decimal" NUMERIC(38, 18);

ALTER TABLE "alert_configs"
ADD COLUMN IF NOT EXISTS "threshold_decimal" NUMERIC(38, 18);

ALTER TABLE "subscriptions"
ADD COLUMN IF NOT EXISTS "amount_decimal" NUMERIC(38, 18);

-- Backfill existing data.
UPDATE "account_assets"
SET "amount_decimal" = "amount"::NUMERIC
WHERE "amount_decimal" IS NULL;

UPDATE "transactions"
SET
	"amount_decimal" = "amount"::NUMERIC,
	"converted_amount_decimal" = CASE
		WHEN "convertedAmount" IS NULL THEN NULL
		ELSE "convertedAmount"::NUMERIC
	END,
	"amount_usd_decimal" = CASE
		WHEN "amount_usd" IS NULL THEN NULL
		ELSE "amount_usd"::NUMERIC
	END
WHERE
	"amount_decimal" IS NULL
	OR ("convertedAmount" IS NOT NULL AND "converted_amount_decimal" IS NULL)
	OR ("amount_usd" IS NOT NULL AND "amount_usd_decimal" IS NULL);

UPDATE "alert_configs"
SET "threshold_decimal" = "threshold"::NUMERIC
WHERE "threshold_decimal" IS NULL;

UPDATE "subscriptions"
SET "amount_decimal" = "amount"::NUMERIC
WHERE "amount_decimal" IS NULL;

-- Useful indexes for upcoming cutover queries.
CREATE INDEX IF NOT EXISTS "transactions_amount_decimal_idx"
ON "transactions"("amount_decimal");

CREATE INDEX IF NOT EXISTS "transactions_amount_usd_decimal_idx"
ON "transactions"("amount_usd_decimal");
