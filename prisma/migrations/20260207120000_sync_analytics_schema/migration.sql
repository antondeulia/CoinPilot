-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN "convertedAmount" DOUBLE PRECISION,
ADD COLUMN "convertToCurrency" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "account_assets_accountId_currency_key" ON "account_assets"("accountId", "currency");

-- CreateEnum
CREATE TYPE "AlertTypeEnum" AS ENUM ('large_expense', 'category_threshold');

-- CreateTable
CREATE TABLE "saved_analytics_views" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_analytics_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_configs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AlertTypeEnum" NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "categoryId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_configs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "saved_analytics_views" ADD CONSTRAINT "saved_analytics_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_configs" ADD CONSTRAINT "alert_configs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
