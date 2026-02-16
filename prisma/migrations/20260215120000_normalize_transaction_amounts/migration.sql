-- Normalize transaction amounts: store always as positive; sign is determined by direction.
UPDATE "transactions" SET amount = ABS(amount) WHERE amount < 0;
UPDATE "transactions" SET "convertedAmount" = ABS("convertedAmount") WHERE "convertedAmount" IS NOT NULL AND "convertedAmount" < 0;
