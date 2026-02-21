-- AlterTable
ALTER TABLE "users"
ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN "lastDailyReminderAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "llm_user_memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_user_memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "llm_user_memories_userId_type_key_key" ON "llm_user_memories"("userId", "type", "key");

-- CreateIndex
CREATE INDEX "llm_user_memories_userId_updatedAt_idx" ON "llm_user_memories"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "llm_user_memories" ADD CONSTRAINT "llm_user_memories_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
