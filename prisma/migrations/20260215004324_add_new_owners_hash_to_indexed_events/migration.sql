/*
  Warnings:

  - Added the required column `newOwnersHash` to the `RecoveryExecutedEvent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `newOwnersHash` to the `RecoveryFinalizedEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "RecoveryExecutedEvent" ADD COLUMN     "newOwnersHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "RecoveryFinalizedEvent" ADD COLUMN     "newOwnersHash" TEXT NOT NULL;
