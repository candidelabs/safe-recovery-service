-- AlterTable
ALTER TABLE "IndexerData" ADD COLUMN     "moduleAddress" TEXT;

-- AlterTable
ALTER TABLE "GuardianAddedEvent" ADD COLUMN     "moduleAddress" TEXT;

-- AlterTable
ALTER TABLE "GuardianRevokedEvent" ADD COLUMN     "moduleAddress" TEXT;

-- AlterTable
ALTER TABLE "ThresholdChangedEvent" ADD COLUMN     "moduleAddress" TEXT;

-- AlterTable
ALTER TABLE "RecoveryExecutedEvent" ADD COLUMN     "moduleAddress" TEXT,
ADD COLUMN     "newOwners" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "recoveryHash" TEXT;

-- AlterTable
ALTER TABLE "RecoveryFinalizedEvent" ADD COLUMN     "moduleAddress" TEXT,
ADD COLUMN     "newOwners" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "recoveryHash" TEXT;

-- AlterTable
ALTER TABLE "RecoveryCanceledEvent" ADD COLUMN     "moduleAddress" TEXT,
ADD COLUMN     "recoveryHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IndexerData_chainId_moduleAddress_key" ON "IndexerData"("chainId", "moduleAddress");

