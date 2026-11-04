-- AlterTable
ALTER TABLE "RecoveryRequest" ADD COLUMN     "moduleAddress" TEXT,
ADD COLUMN     "recoveryHash" TEXT;

-- AlterTable
ALTER TABLE "AuthSignatureRequest" ADD COLUMN     "moduleAddress" TEXT;

