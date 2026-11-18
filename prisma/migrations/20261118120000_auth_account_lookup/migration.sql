-- CreateTable
CREATE TABLE "AuthAccountLookupRequest" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAccountLookupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthAccountLookupRequest_channel_target_createdAt_idx" ON "AuthAccountLookupRequest"("channel", "target", "createdAt");

-- CreateIndex
CREATE INDEX "AuthRegistration_channel_target_idx" ON "AuthRegistration"("channel", "target");

