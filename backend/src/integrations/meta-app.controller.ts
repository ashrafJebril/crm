import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
} from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { techProviderEnabled } from "../common/meta-app";
import { PrismaService } from "../prisma/prisma.service";
import { MetaComplianceService } from "./meta-compliance.service";

const GRAPH_VERSION = "v21.0";

@Controller()
export class MetaAppController {
  constructor(
    private readonly compliance: MetaComplianceService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * What the Settings → Integrations screen needs to render the popup connect
   * buttons. `enabled: false` (the default until Meta approves us) hides them.
   * `zernio` flags platforms owned by Zernio in this workspace — the popup is
   * not offered for those (a Meta connect would collide with the Zernio row).
   */
  @Get("integrations/meta/config")
  async config(@CurrentWorkspace() workspaceId: string) {
    const zernioRows = await this.prisma.integration.findMany({
      where: { workspaceId, provider: "zernio" },
      select: { platform: true },
    });
    const zernio = {
      whatsapp: zernioRows.some((r) => r.platform === "whatsapp"),
      facebook: zernioRows.some((r) => r.platform === "facebook"),
      instagram: zernioRows.some((r) => r.platform === "instagram"),
    };
    if (!techProviderEnabled()) return { enabled: false, zernio };
    return {
      enabled: true,
      appId: process.env.META_APP_ID ?? null,
      waConfigId: process.env.META_WA_CONFIG_ID ?? null,
      fbConfigId: process.env.META_FB_CONFIG_ID ?? null,
      graphVersion: GRAPH_VERSION,
      zernio,
    };
  }

  // ── Meta app callbacks (paste these URLs into the Meta app dashboard) ────

  /** App Settings → Advanced → Deauthorize callback URL. */
  @Public()
  @Post("meta/deauthorize")
  @HttpCode(200)
  async deauthorize(@Body() body: { signed_request?: string }) {
    const userId = this.compliance.verify(body?.signed_request);
    if (!userId) throw new BadRequestException("Invalid signed_request");
    await this.compliance.removeConnectionsForUser(userId);
    return { ok: true };
  }

  /** App Settings → Basic → Data deletion callback URL. */
  @Public()
  @Post("meta/data-deletion")
  @HttpCode(200)
  async dataDeletion(@Body() body: { signed_request?: string }) {
    const userId = this.compliance.verify(body?.signed_request);
    if (!userId) throw new BadRequestException("Invalid signed_request");
    await this.compliance.removeConnectionsForUser(userId);
    const code = this.compliance.newConfirmationCode();
    const base = process.env.BACKEND_PUBLIC_URL ?? "http://localhost:3001";
    return {
      url: `${base}/api/meta/data-deletion/status?code=${code}`,
      confirmation_code: code,
    };
  }

  /**
   * Status page Meta links the user to. Deletion runs synchronously inside
   * the callback, so any issued code is already complete.
   */
  @Public()
  @Get("meta/data-deletion/status")
  @Header("Content-Type", "text/html; charset=utf-8")
  status(@Query("code") code?: string) {
    const safe = (code ?? "").replace(/[^a-f0-9]/gi, "").slice(0, 32);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data deletion status</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">
<h1 style="font-size:1.4rem">Data deletion request</h1>
${safe ? `<p>Confirmation code: <code>${safe}</code></p>` : ""}
<p><strong>Status: completed.</strong> Your Facebook, Instagram and WhatsApp connection data (access tokens and account identifiers) has been deleted from Kewy Marketing.</p>
<p>Messages and contacts held in a business's CRM belong to that business. To ask for those to be removed, contact the business directly.</p>
</body></html>`;
  }
}
