-- CreateTable
CREATE TABLE "SponsoredDeployment" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "minedAttempts" INTEGER NOT NULL DEFAULT 0,
    "signerId" TEXT NOT NULL,
    "requesterHash" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "transactionHash" TEXT,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsoredDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SponsoredDeployment_chainId_requestedAt_idx" ON "SponsoredDeployment"("chainId", "requestedAt");

-- CreateIndex
CREATE INDEX "SponsoredDeployment_chainId_requesterHash_requestedAt_idx" ON "SponsoredDeployment"("chainId", "requesterHash", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SponsoredDeployment_account_chainId_key" ON "SponsoredDeployment"("account", "chainId");

