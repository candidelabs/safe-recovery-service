-- CreateTable
CREATE TABLE "AuthRegistration" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "guardian" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRegistrationRequest" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRegistrationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRegistrationLogs" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRegistrationLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthRegistration_account_idx" ON "AuthRegistration"("account");

-- CreateIndex
CREATE INDEX "AuthRegistrationRequest_account_idx" ON "AuthRegistrationRequest"("account");
