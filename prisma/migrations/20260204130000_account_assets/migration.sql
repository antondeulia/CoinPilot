-- CreateTable
CREATE TABLE "account_assets" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "account_assets_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "account_assets" ADD CONSTRAINT "account_assets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

