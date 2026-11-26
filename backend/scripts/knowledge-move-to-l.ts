/* eslint-disable no-console */
// Copy each workspace's knowledge from crm's own tables to l, where it now
// lives (src/knowledge-sources/knowledge-move.ts says what moves and how).
// DRY RUN BY DEFAULT: it prints what it would copy and writes nothing.
// Rerunnable. Never deletes anything in crm. Only workspaces linked to l.
//
// Usage (from backend/, with the production env):
//   npx dotenv -e .env -- tsx scripts/knowledge-move-to-l.ts --workspace <id>          (dry run)
//   npx dotenv -e .env -- tsx scripts/knowledge-move-to-l.ts --all                     (dry run)
//   npx dotenv -e .env -- tsx scripts/knowledge-move-to-l.ts --all --apply             (writes)
import { PrismaClient } from "@prisma/client";
import { LJoteckClient } from "../src/integrations/l-joteck.client";
import { LAgentResolverService } from "../src/integrations/l-agent-resolver.service";
import { LAgentSetupService } from "../src/integrations/l-agent-setup.service";
import { moveKnowledgeToL, type MoveRow } from "../src/knowledge-sources/knowledge-move";
import { MediaStorageProvider } from "../src/media/storage/storage.provider";
import { LocalStorage } from "../src/media/storage/local-storage";

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
  const l = new LJoteckClient();
  if (!l.enabled) throw new Error("L_API_URL and L_JOTECK_SECRET must be set");
  const storage = MediaStorageProvider.useFactory() as { kind: string; getSignedUrl: (k: string, ttl: number) => Promise<string> };
  // crm's own resolver and prompt-block writer (prompt versions, the lock).
  const resolver = new LAgentResolverService(prisma as never, l);
  const setup = new LAgentSetupService({ raw: prisma } as never, l, resolver, {} as never, {} as never);
  try {
    const counts = await moveKnowledgeToL(
      {
        workspaces: async (ids) =>
          (
            await prisma.workspace.findMany({
              where: { lWorkspaceId: { not: null }, ...(ids === "all" ? {} : { id: { in: ids } }) },
              select: { id: true, lWorkspaceId: true, timezone: true },
            })
          ).map((w) => ({ id: w.id, lWorkspaceId: w.lWorkspaceId as string, timezone: w.timezone })),
        sources: async (workspaceId) =>
          (await prisma.knowledgeSource.findMany({
            where: { workspaceId, kind: { not: "tombstone" } },
            select: {
              id: true, kind: true, title: true, bodyJson: true, body: true, question: true, order: true, typedKind: true,
              url: true, scope: true, schedule: true, legacyRef: true,
              media: { select: { fileName: true, mimeType: true, sizeBytes: true, storageKind: true, storedPath: true } },
            },
          })) as unknown as MoveRow[],
        l: (path, o) => l.request(path, { ...o, passErrors: "knowledge." }),
        agentSlug: (ws, lws) => resolver.resolveSlug(ws, lws),
        readFile: async (m) => {
          if (m.storageKind === "spaces") {
            const res = await fetch(await storage.getSignedUrl(m.storedPath, 300));
            if (!res.ok) throw new Error(`stored file unreadable (${res.status})`);
            return Buffer.from(await res.arrayBuffer());
          }
          const abs = new LocalStorage().resolveAbsolute(m.storedPath);
          if (!abs) throw new Error("stored file path is outside the media root");
          const fs = await import("node:fs/promises");
          return fs.readFile(abs);
        },
        // An empty block is removed; l now adds the guidelines itself.
        dropGuidelinesBlock: (workspaceId) => setup.writePromptBlock(workspaceId, "guidelines", ""),
        log: (line) => console.log(line),
      },
      opts,
    );
    console.log(opts.dryRun ? "Dry run: nothing written. Re-run with --apply to copy." : "Done.");
    console.log(JSON.stringify(counts, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
