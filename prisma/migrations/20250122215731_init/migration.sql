-- CreateTable
CREATE TABLE "RecoveryRequest" (
    "id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "newOwners" TEXT[],
    "newThreshold" INTEGER NOT NULL,
    "nonce" BIGINT NOT NULL,
    "signatures" JSONB NOT NULL,
    "executeTransactionHash" TEXT DEFAULT '',
    "finalizeTransactionHash" TEXT DEFAULT '',
    "status" TEXT NOT NULL,
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecoveryRequest_account_idx" ON "RecoveryRequest"("account");
