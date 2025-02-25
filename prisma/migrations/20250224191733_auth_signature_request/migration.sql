-- CreateTable
CREATE TABLE "AuthSignatureRequest" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "newOwners" TEXT[],
    "newThreshold" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL,
    "nonce" BIGINT NOT NULL,
    "requiredVerifications" INTEGER NOT NULL,
    "guardian" TEXT,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSignatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureRequestVerification" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "authSignatureRequestId" TEXT NOT NULL,

    CONSTRAINT "SignatureRequestVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSignatureRequestLogs" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthSignatureRequestLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthSignatureRequest_account_idx" ON "AuthSignatureRequest"("account");

-- AddForeignKey
ALTER TABLE "SignatureRequestVerification" ADD CONSTRAINT "SignatureRequestVerification_authSignatureRequestId_fkey" FOREIGN KEY ("authSignatureRequestId") REFERENCES "AuthSignatureRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
