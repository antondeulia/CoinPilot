ALTER TABLE "transactions"
	ADD COLUMN IF NOT EXISTS "trade_fee_currency" TEXT,
	ADD COLUMN IF NOT EXISTS "trade_fee_amount" NUMERIC(36, 18);

