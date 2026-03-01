ALTER TABLE "transactions"
ADD COLUMN "amount_usd" DOUBLE PRECISION;

CREATE TABLE "exchange_rate_snapshots" (
  "id" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "base_currency" TEXT NOT NULL DEFAULT 'USD',
  "rates" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "exchange_rate_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rate_snapshots_date_base_currency_key"
ON "exchange_rate_snapshots"("date", "base_currency");
