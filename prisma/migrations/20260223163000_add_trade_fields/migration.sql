DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradeTypeEnum') THEN
		CREATE TYPE "TradeTypeEnum" AS ENUM ('buy', 'sell');
	END IF;
END $$;

ALTER TABLE "transactions"
	ADD COLUMN IF NOT EXISTS "trade_type" "TradeTypeEnum",
	ADD COLUMN IF NOT EXISTS "trade_base_currency" TEXT,
	ADD COLUMN IF NOT EXISTS "trade_base_amount" DOUBLE PRECISION,
	ADD COLUMN IF NOT EXISTS "trade_quote_currency" TEXT,
	ADD COLUMN IF NOT EXISTS "trade_quote_amount" DOUBLE PRECISION,
	ADD COLUMN IF NOT EXISTS "execution_price" DOUBLE PRECISION;
