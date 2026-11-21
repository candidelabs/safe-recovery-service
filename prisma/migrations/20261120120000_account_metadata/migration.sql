-- AlterTable
ALTER TABLE "AuthRegistrationRequest" ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "AuthAccountMetadata" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAccountMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccountMetadata_account_chainId_key" ON "AuthAccountMetadata"("account", "chainId");

