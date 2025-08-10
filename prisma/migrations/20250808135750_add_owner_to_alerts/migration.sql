/*
  Warnings:

  - Added the required column `owner` to the `AlertLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `owner` to the `AlertSubscription` table without a default value. This is not possible if the table is not empty.
  - Added the required column `owner` to the `AlertSubscriptionNotification` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."AlertLog" ADD COLUMN     "owner" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."AlertSubscription" ADD COLUMN     "owner" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."AlertSubscriptionNotification" ADD COLUMN     "owner" TEXT NOT NULL;
