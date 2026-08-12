-- Kapso is removed as a WhatsApp provider — WhatsApp now runs through Zernio
-- like Facebook and Instagram. This column mapped a workspace to its Kapso
-- BSP customer id and nothing reads it any more.
ALTER TABLE "Workspace" DROP COLUMN "kapsoCustomerId";
