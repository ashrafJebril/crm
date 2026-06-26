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
}

export class HjzClientWebhookDto {
  @IsIn(["client.upserted", "client.deleted"])
  event!: "client.upserted" | "client.deleted";

  @ValidateNested()
  @Type(() => HjzClientPayloadDto)
  client!: HjzClientPayloadDto;
}

// ---------------------------------------------------------------------------
// Segment webhook DTOs
// ---------------------------------------------------------------------------

export class HjzSegmentUpsertPayloadDto {
  @IsString() @MinLength(1) id!: string;
  @IsString() @MinLength(1) tenantId!: string;
  @IsString() @MinLength(1) name!: string;
  @IsOptional() rules?: unknown;
  @IsOptional() @IsBoolean() showOnProfile?: boolean;
  @IsArray() @IsString({ each: true }) clientIds!: string[];
}

export class HjzSegmentDeletePayloadDto {
  @IsString() @MinLength(1) id!: string;
  @IsString() @MinLength(1) tenantId!: string;
}

export class HjzSegmentWebhookDto {
  @IsIn(["segment.upserted", "segment.deleted"])
  event!: "segment.upserted" | "segment.deleted";

  // We use `any` here because class-validator's @Type cannot discriminate
  // between upsert vs delete payloads. Validation is done inside handleSegment.
  segment!: any;
}
