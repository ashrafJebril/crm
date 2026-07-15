import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { IsBoolean, IsOptional, IsString } from "class-validator";
import { KapsoService } from "./kapso.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { Public } from "../auth/public.decorator";
import { KapsoWebhookSignatureGuard } from "../common/kapso-webhook-signature.guard";

class RecordConnectionDto {
  @IsString() phoneNumberId!: string;
  @IsOptional() @IsString() wabaId?: string;
  @IsOptional() @IsString() displayPhoneNumber?: string;
}

class SetupLinkDto {
  // When true, Kapso provisions a pre-verified test number instead of the
  // customer bringing their own.
  @IsOptional() @IsBoolean() provision?: boolean;
}

@Controller()
export class KapsoController {
  constructor(private readonly kapso: KapsoService) {}

  // ── Tenant-scoped ────────────────────────────────────────────────────────
  @Get("integrations/kapso/status")
  status(@CurrentWorkspace() workspaceId: string) {
    return this.kapso.status(workspaceId);
  }

  /** Mint an embedded-signup setup link for the customer to connect their WABA.
   *  Pass { provision: true } to have Kapso hand out a pre-verified test number. */
  @Post("integrations/kapso/setup-link")
  setupLink(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: SetupLinkDto,
  ) {
    return this.kapso.createSetupLink(workspaceId, { provision: !!dto?.provision });
  }

  /**
   * Called by the frontend after the success redirect (it carries
   * phone_number_id etc. in the query) so the connection shows immediately,
   * without waiting for the webhook. Idempotent with the webhook path.
   */
  @Post("integrations/kapso/connected")
  connected(
    @CurrentWorkspace() workspaceId: string,
    @Body() dto: RecordConnectionDto,
  ) {
    return this.kapso.recordConnection(workspaceId, {
      phoneNumberId: dto.phoneNumberId,
      wabaId: dto.wabaId ?? null,
      displayPhoneNumber: dto.displayPhoneNumber ?? null,
    });
  }

  @Delete("integrations/kapso/disconnect")
  disconnect(@CurrentWorkspace() workspaceId: string) {
    return this.kapso.disconnect(workspaceId);
  }

  // ── Public webhook (Kapso calls this) ──────────────────────────────────
  @Public()
  @UseGuards(KapsoWebhookSignatureGuard)
  @Post("webhooks/kapso")
  @HttpCode(200)
  receive(
    @Headers("x-webhook-event") event: string | undefined,
    @Body() payload: unknown,
  ) {
    return this.kapso.handleEvent(
      event,
      payload as Parameters<KapsoService["handleEvent"]>[1],
    );
  }
}
