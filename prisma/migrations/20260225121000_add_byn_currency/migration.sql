INSERT INTO "currencies" ("code", "type", "symbol", "decimals")
VALUES ('BYN', 'fiat', 'Br', 2)
ON CONFLICT ("code") DO NOTHING;
