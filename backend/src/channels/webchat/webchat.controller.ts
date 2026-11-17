import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { IsISO8601, IsOptional, IsString, MaxLength } from "class-validator";
import { Public } from "../../auth/public.decorator";
import { WIDGET_JS } from "./assets/widget.js";
import { WebchatService } from "./webchat.service";
import { primaryApiOrigin, visitorTokenHeader, WidgetOriginGuard, type WidgetRequest } from "./widget-origin.guard";
import { WidgetRateLimitGuard } from "./widget-rate-limit.guard";

/* Query/body shapes for the JSON routes. The global ValidationPipe rejects
 * unknown keys there; the service enforces the real limits (1–2000 chars,
 * name <= 80) with the widget.invalid_message key, so these caps only bound
 * the payload. The hosted page takes its params individually instead (I2),
 * so a shared link with fbclid/utm_* still opens. The visitor token is never
 * a query or body field: it travels in the X-Visitor-Token header (m5). */

export class WidgetConfigQueryDto {
  @IsOptional() @IsString() @MaxLength(300) parent?: string;
}

export class WidgetMessagesQueryDto {
  @IsString() @MaxLength(64) visitorId!: string;
  @IsOptional() @IsISO8601() after?: string;
  @IsOptional() @IsString() @MaxLength(300) parent?: string;
}

export class PostWidgetMessageDto {
  @IsString() @MaxLength(8000) body!: string;
  @IsOptional() @IsString() @MaxLength(400) name?: string;
  @IsOptional() @IsString() @MaxLength(64) visitorId?: string;
  @IsOptional() @IsString() @MaxLength(300) parent?: string;
}

interface HeaderRes {
  setHeader(name: string, value: string): unknown;
}

const PUBLIC_JSON_HEADERS = [
  ["Cache-Control", "no-store"],
  ["X-Content-Type-Options", "nosniff"],
] as const;

/**
 * Public web chat routes (all `@Public()`, mapped "public" in
 * permission-map.ts):
 *  - `GET /widget.js` — the loader (no guard: static, no channel data);
 *  - `GET /chat/:channelId` — the hosted chat page (embed or direct link);
 *  - `GET /widget/:channelId/config` — public config only;
 *  - `GET|POST /widget/:channelId/messages` — the visitor's own thread; the
 *    visitor token comes from the `X-Visitor-Token` header only.
 * Every channel route runs WidgetRateLimitGuard (429) then
 * WidgetOriginGuard (404 / 403). Agent replies go through the member route
 * `POST /conversations/:id/send` and the `native` transport.
 */
@Controller()
export class WebchatController {
  constructor(private readonly svc: WebchatService) {}

  @Public()
  @Get("widget.js")
  @Header("Content-Type", "application/javascript; charset=utf-8")
  @Header("Cache-Control", "public, max-age=300")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Cross-Origin-Resource-Policy", "cross-origin")
  loader(): string {
    return WIDGET_JS;
  }

  @Public()
  @UseGuards(WidgetRateLimitGuard, WidgetOriginGuard)
  @Get("chat/:channelId")
  async page(
    @Req() req: WidgetRequest,
    @Query("embed") embedParam: unknown,
    @Query("lang") langParam: unknown,
    // Read by WidgetOriginGuard from req.query (verified there); bound here
    // only so the handler declares every parameter it understands.
    @Query("parent") _parent: unknown,
    @Res({ passthrough: true }) res: HeaderRes,
  ): Promise<string> {
    // Individual params (not a DTO): unknown keys such as fbclid or utm_*
    // are ignored, and odd values fall back to the defaults.
    const embed = embedParam === "1";
    const lang = langParam === "en" || langParam === "ar" ? langParam : undefined;
    const { html, csp } = await this.svc.renderPage(req.widgetChannel!, {
      embed,
      lang,
      acceptLanguage: req.headers["accept-language"],
      apiOrigin: primaryApiOrigin(req),
      parent: req.widgetParent ?? null,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    return html;
  }

  @Public()
  @UseGuards(WidgetRateLimitGuard, WidgetOriginGuard)
  @Get("widget/:channelId/config")
  config(@Req() req: WidgetRequest, @Query() _q: WidgetConfigQueryDto, @Res({ passthrough: true }) res: HeaderRes) {
    for (const [k, v] of PUBLIC_JSON_HEADERS) res.setHeader(k, v);
    // SP-29: with the workspace brand (logo, colour precedence channel > workspace > default).
    return this.svc.publicConfigWithBrand(req.widgetChannel!);
  }

  @Public()
  @UseGuards(WidgetRateLimitGuard, WidgetOriginGuard)
  @Get("widget/:channelId/messages")
  messages(@Req() req: WidgetRequest, @Query() q: WidgetMessagesQueryDto, @Res({ passthrough: true }) res: HeaderRes) {
    for (const [k, v] of PUBLIC_JSON_HEADERS) res.setHeader(k, v);
    return this.svc.listMessages(req.widgetChannel!, { visitorId: q.visitorId, after: q.after, visitorToken: visitorTokenHeader(req) });
  }

  @Public()
  @UseGuards(WidgetRateLimitGuard, WidgetOriginGuard)
  @Post("widget/:channelId/messages")
  @HttpCode(200)
  send(@Req() req: WidgetRequest, @Body() dto: PostWidgetMessageDto, @Res({ passthrough: true }) res: HeaderRes) {
    for (const [k, v] of PUBLIC_JSON_HEADERS) res.setHeader(k, v);
    return this.svc.postMessage(req.widgetChannel!, {
      body: dto.body,
      name: dto.name,
      visitorId: dto.visitorId,
      visitorToken: visitorTokenHeader(req),
    });
  }
}
