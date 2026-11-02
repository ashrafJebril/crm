import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHmac, randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

/** Long enough to open a tab; anything longer HJZ refuses (MAX 120s there). */
const TICKET_TTL_SEC = 60;

/**
 * CRM → HJZ without a second login. For the signed-in CRM user this signs a
 * single-use ticket that the HJZ web app trades for a normal HJZ session
 * (POST /auth/sso/crm there). HJZ only honours links that can't be set from
 * the CRM side: the HJZ user id this user arrived with via HJZ → CRM SSO
 * (User.externalId) or a shared Kewy identity — never an email.
 *
 * Key: HMAC-SHA256(HJZ_WEBHOOK_SECRET, "crm-sso-v1"), the same derivation as
 * HJZ's crmSsoKey(), from the secret the sync webhooks already share.
 */
@Injectable()
export class HjzLinkService {
  private readonly jwt = new JwtService();

  constructor(private readonly prisma: PrismaService) {}

  /** What the "Open HJZ" button needs: show it at all, and can it sign in. */
  async status(workspaceId: string, userId: string) {
    const [ws, user] = await this.load(workspaceId, userId);
    const connected = !!ws?.externalTenantId && !!webUrl() && !!secret();
    return { connected, linked: connected && !!(user?.externalId || user?.kewyAccountId) };
  }

  async ticketUrl(workspaceId: string, userId: string): Promise<{ url: string }> {
    const [ws, user] = await this.load(workspaceId, userId);
    const base = webUrl();
    const key = secret();
    if (!ws?.externalTenantId || !base || !key) {
      throw new ServiceUnavailableException({ code: "HJZ_NOT_CONNECTED", message: "This workspace is not connected to HJZ" });
    }
    if (!user?.externalId && !user?.kewyAccountId) {
      throw new ConflictException({
        code: "HJZ_ACCOUNT_NOT_LINKED",
        message: "Your CRM user is not linked to an HJZ account. Open the CRM from HJZ once to link it.",
      });
    }
    const ticket = this.jwt.sign(
      { tid: ws.externalTenantId, hjzUserId: user.externalId, kewyAccountId: user.kewyAccountId },
      {
        secret: createHmac("sha256", key).update("crm-sso-v1").digest("hex"),
        algorithm: "HS256",
        issuer: "crm",
        audience: "hjz",
        expiresIn: TICKET_TTL_SEC,
        jwtid: randomUUID(),
      },
    );
    return { url: `${base}/#crm_ticket=${encodeURIComponent(ticket)}` };
  }

  private load(workspaceId: string, userId: string) {
    return Promise.all([
      this.prisma.raw.workspace.findUnique({ where: { id: workspaceId }, select: { externalTenantId: true } }),
      this.prisma.raw.user.findUnique({ where: { id: userId }, select: { externalId: true, kewyAccountId: true } }),
    ]);
  }
}

/** HJZ web app origin, e.g. https://app.hjz.example (no trailing slash). */
function webUrl(): string | null {
  return process.env.HJZ_WEB_URL?.trim().replace(/\/+$/, "") || null;
}

function secret(): string | null {
  return process.env.HJZ_WEBHOOK_SECRET?.trim() || null;
}
