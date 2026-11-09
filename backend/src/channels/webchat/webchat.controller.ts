import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from "class-validator";
import { Public } from "../../auth/public.decorator";
import { WIDGET_JS } from "./assets/widget.js";
import { WebchatService } from "./webchat.service";
import { primaryApiOrigin, WidgetOriginGuard, type WidgetRequest } from "./widget-origin.guard";
import { WidgetRateLimitGuard } from "./widget-rate-limit.guard";

/* Query/body shapes. The global ValidationPipe rejects unknown keys; the
 * service enforces the real limits (1–2000 chars, name <= 80) with the
 * widget.invalid_message key, so these caps only bound the payload. */
export class ChatPageQueryDto {
  @IsOptional() @IsIn(["0", "1"]) embed?: string;
  @IsOptional() @IsString() @MaxLength(300) parent?: string;
  @IsOptional() @IsIn(["en", "ar"]) lang?: string;
}

export class WidgetConfigQueryDto {
  @IsOptional() @IsString() @MaxLength(300) parent?: string;
}

export class WidgetMessagesQueryDto {
  @IsString() @MaxLength(64) visitorId!: string;
  @IsString() @MaxLength(128) visitorToken!: string;
  @IsOptional() @IsISO8601() after?: string;
  @IsOptional() @IsString() @MaxLength(300) parent?: string;
}

export class PostWidgetMessageDto {
  @IsString() @MaxLength(8000) body!: string;
  @IsOptional() @IsString() @MaxLength(400) name?: string;
  @IsOptional() @IsString() @MaxLength(64) visitorId?: string;
  @IsOptional() @IsString() @MaxLength(128) visitorToken?: string;
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
 *  - `GET|POST /widget/:channelId/messages` — the visitor's own thread.
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
  async page(@Req() req: WidgetRequest, @Query() q: ChatPageQueryDto, @Res({ passthrough: true }) res: HeaderRes): Promise<string> {
    const embed = q.embed === "1";
    const { html, csp } = await this.svc.renderPage(req.widgetChannel!, {
      embed,
      lang: q.lang,
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
    return this.svc.publicConfig(req.widgetChannel!);
  }

  @Public()
  @UseGuards(WidgetRateLimitGuard, WidgetOriginGuard)
  @Get("widget/:channelId/messages")
  messages(@Req() req: WidgetRequest, @Query() q: WidgetMessagesQueryDto, @Res({ passthrough: true }) res: HeaderRes) {
    for (const [k, v] of PUBLIC_JSON_HEADERS) res.setHeader(k, v);
    return this.svc.listMessages(req.widgetChannel!, q);
  }

  @Public()
  @UseGuards(WidgetRateLimitGuard, WidgetOriginGuard)
  @Post("widget/:channelId/messages")
  @HttpCode(200)
  send(@Req() req: WidgetRequest, @Body() dto: PostWidgetMessageDto, @Res({ passthrough: true }) res: HeaderRes) {
    for (const [k, v] of PUBLIC_JSON_HEADERS) res.setHeader(k, v);
    return this.svc.postMessage(req.widgetChannel!, dto);
  }
}
