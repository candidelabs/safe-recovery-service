/*
  Warnings:

  - Added the required column `owner` to the `AlertSubscription` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AlertSubscription" ADD COLUMN     "owner" TEXT NOT NULL;
