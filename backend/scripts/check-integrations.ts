/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();
(async () => {
  const rows = await p.integration.findMany({
    select: { platform: true, pageName: true, pageId: true, workspaceId: true, lastFetchedAt: true },
  });
  console.log(JSON.stringify(rows, null, 2));
  await p.$disconnect();
})();
