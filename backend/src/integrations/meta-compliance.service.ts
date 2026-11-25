import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { allMetaAppSecrets, parseSignedRequest } from "../common/meta-app";

/**
 * Meta's required app callbacks (App Review checks both URLs):
 *  - Deauthorize: a user removed our app from their Facebook account.
 *  - Data deletion: a user asked Meta to delete the data we hold about them.
 *
 * Scope (owner decision, 2026-11-06): we delete only OUR Meta connection data
 * for that user — the Integration rows (tokens, Page/IG/WABA ids) they created
 * through our login. Conversations, messages and contacts belong to the
 * customer's business CRM and are kept. Zernio rows are never touched.
 *
 * Rows are matched on `raw.metaUserId` (the app-scoped user id captured at
 * connect). Token-paste connections never went through our login and carry no
 * id, so they're not matched.
 */
@Injectable()
export class MetaComplianceService {
  private readonly log = new Logger(MetaComplianceService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the verified app-scoped user id, or null if the request is bad. */
  verify(signedRequest: string | undefined): string | null {
    const payload = parseSignedRequest(signedRequest, allMetaAppSecrets());
    const userId = payload?.user_id;
    // App-scoped ids are numeric; anything else is not from Meta.
    return typeof userId === "string" && /^\d+$/.test(userId) ? userId : null;
  }

  async removeConnectionsForUser(metaUserId: string): Promise<number> {
    const rows = await this.prisma.integration.findMany({
      where: {
        provider: "meta",
        raw: { contains: `"metaUserId":"${metaUserId}"` },
      },
      select: { id: true, workspaceId: true, platform: true, raw: true },
    });
    // `contains` is a cheap prefilter — confirm on the parsed JSON.
    const ids = rows
      .filter((r) => {
        try {
          return JSON.parse(r.raw ?? "{}").metaUserId === metaUserId;
        } catch {
          return false;
        }
      })
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    const { count } = await this.prisma.integration.deleteMany({
      where: { id: { in: ids }, provider: "meta" },
    });
    this.log.log(`Removed ${count} Meta connection(s) for app-scoped user ${metaUserId}`);
    return count;
  }

  newConfirmationCode(): string {
    return randomBytes(8).toString("hex");
  }
}
