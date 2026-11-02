import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from "class-validator";

/** Flattened hjz Client payload sent by hjz-v2's MarketingWebhookService. */
export class HjzClientPayloadDto {
  @IsString() @MinLength(1) id!: string;
  @IsString() @MinLength(1) tenantId!: string;
  @IsString() @MinLength(1) name!: string;
  // hjz may carry legacy email values, so don't enforce strict RFC email.
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsBoolean() blocked?: boolean;
  @IsOptional() @IsString() deletedAt?: string | null;
  // Sent by hjz with every event; the global pipe forbids unknown fields, so
  // they must be declared even though only the opt-out event acts on them.
  @IsOptional() @IsBoolean() acceptsMarketingEmail?: boolean;
  @IsOptional() @IsBoolean() acceptsMarketingWhatsapp?: boolean;
}

export class HjzClientWebhookDto {
  // client.opted_out: the client withdrew marketing consent in hjz (no contact data attached).
  @IsIn(["client.upserted", "client.deleted", "client.opted_out"])
  event!: "client.upserted" | "client.deleted" | "client.opted_out";

  @ValidateNested()
  @Type(() => HjzClientPayloadDto)
  client!: HjzClientPayloadDto;
}

// ---------------------------------------------------------------------------
// Segment webhook DTOs
// ---------------------------------------------------------------------------

export class HjzSegmentPayloadDto {
  @IsString() @MinLength(1) id!: string;
  @IsString() @MinLength(1) tenantId!: string;
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() rules?: unknown;
  @IsOptional() @IsBoolean() showOnProfile?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) clientIds?: string[];
}

export class HjzSegmentWebhookDto {
  @IsIn(["segment.upserted", "segment.deleted"])
  event!: "segment.upserted" | "segment.deleted";

  @ValidateNested()
  @Type(() => HjzSegmentPayloadDto)
  segment!: HjzSegmentPayloadDto;
}
