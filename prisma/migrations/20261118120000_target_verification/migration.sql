-- CreateTable
CREATE TABLE "TargetVerification" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TargetVerification_tokenHash_key" ON "TargetVerification"("tokenHash");

-- CreateIndex
CREATE INDEX "TargetVerification_channel_target_createdAt_idx" ON "TargetVerification"("channel", "target", "createdAt");

-- CreateIndex
CREATE INDEX "AuthRegistration_channel_target_idx" ON "AuthRegistration"("channel", "target");

