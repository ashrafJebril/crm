/* eslint-disable no-console */
// SP-21 (ruling 3) migrate-in: the editable kewy-ai documents and the l
// documents appear as knowledge sources. DRY RUN BY DEFAULT: it prints what it
// would create and writes nothing. Rerunnable (keyed by legacyRef); never
// deletes or changes anything upstream; HJZ-synced kewy-ai docs are skipped.
// kewy-ai docs SP-21 published itself (their id is already a source's
// upstream.kewy.docId) are skipped too, counted as publishedSkipped.
//
// It runs ONLY after the user's explicit approval (ruling 14), per workspace
// or for all. Usage (from backend/):
//   npx dotenv -e .env -- tsx scripts/knowledge-migrate-in.ts --workspace <id>          (dry run)
//   npx dotenv -e .env -- tsx scripts/knowledge-migrate-in.ts --all                     (dry run)
//   npx dotenv -e .env -- tsx scripts/knowledge-migrate-in.ts --workspace <id> --apply  (writes)
import { PrismaClient } from "@prisma/client";
import { KnowledgeClient } from "../src/knowledge/knowledge.client";
import { tenantIdFor } from "../src/knowledge/tenant";
import { LJoteckClient } from "../src/integrations/l-joteck.client";
import type { LDocument } from "../src/integrations/l-knowledge.service";
import { migrateIn } from "../src/knowledge-sources/knowledge-migrate-in";

function args(argv: string[]): { workspaceIds: string[] | "all"; dryRun: boolean } {
  const all = argv.includes("--all");
  const at = argv.indexOf("--workspace");
  const ws = at >= 0 ? argv[at + 1] : undefined;
  if (all === !!ws) {
    console.error("Pass exactly one of --workspace <id> or --all. Add --apply to write (default: dry run).");
    process.exit(2);
  }
  return { workspaceIds: all ? "all" : [ws as string], dryRun: !argv.includes("--apply") };
}

async function main() {
  const opts = args(process.argv.slice(2));
  const prisma = new PrismaClient();
  const kewy = new KnowledgeClient();
  const l = new LJoteckClient();
  try {
    const counts = await migrateIn(
      {
        db: prisma as never,
        kewyDocs: kewy.isConfigured() ? async (ws) => (await kewy.listDocs(tenantIdFor(ws))).docs : undefined,
        lDocs: l.enabled
          ? async (ws) => {
              const row = await prisma.workspace.findUnique({ where: { id: ws }, select: { lWorkspaceId: true } });
              return row?.lWorkspaceId ? l.request<LDocument[]>(`/workspaces/${row.lWorkspaceId}/documents`) : [];
            }
          : undefined,
        log: (line) => console.log(line),
      },
      opts,
    );
    console.log(opts.dryRun ? "Dry run: nothing written. Re-run with --apply after approval." : "Done.");
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
