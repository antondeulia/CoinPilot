/*
  Warnings:

  - You are about to drop the column `agentEnabled` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `user_memories` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "user_memories" DROP CONSTRAINT "user_memories_userId_fkey";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "agentEnabled";

-- DropTable
DROP TABLE "user_memories";
