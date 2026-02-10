-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('monthly', 'yearly', 'lifetime', 'trial');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "PremiumEventType" AS ENUM ('limit_hit', 'premium_page_view', 'upsell_shown', 'feature_blocked', 'trial_start', 'trial_end', 'purchase', 'cancellation', 'export_blocked');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "isPremium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "premiumUntil" TIMESTAMP(3),
ADD COLUMN "trialUsed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "categories" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tags" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "telegramPaymentChargeId" TEXT,
    "providerPaymentChargeId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "premium_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PremiumEventType" NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "premium_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_telegramPaymentChargeId_key" ON "subscriptions"("telegramPaymentChargeId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "premium_events" ADD CONSTRAINT "premium_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
