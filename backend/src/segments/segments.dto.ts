import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import type { SegmentFilter } from "./audience-rules";

export class SegmentFilterDto implements SegmentFilter {
  @IsOptional() @IsArray() @IsString({ each: true }) lifecycle?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) industry?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) source?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) tagsAll?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) tagsAny?: string[];
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsBoolean() hasPhone?: boolean;
}

/** `rules` is shape-checked here only as an object; the deep check is `validateRules` (400 audiences.invalid_rules). */
export class CreateSegmentDto {
  @IsString() @IsNotEmpty() @MaxLength(64) name!: string;
  @IsOptional() @IsString() @MaxLength(64) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @IsIn(["crm", "manual"]) origin?: "crm" | "manual";
  @IsOptional() @ValidateNested() @Type(() => SegmentFilterDto) filter?: SegmentFilterDto;
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
}

export class UpdateSegmentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(64) name?: string;
  @IsOptional() @IsString() @MaxLength(64) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
  @IsOptional() @ValidateNested() @Type(() => SegmentFilterDto) filter?: SegmentFilterDto;
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
  /** Optimistic concurrency (ruling 11). Optional only for older clients. */
  @IsOptional() @IsInt() @Min(0) version?: number;
}

export class PreviewSegmentDto {
  @IsOptional() @ValidateNested() @Type(() => SegmentFilterDto) filter?: SegmentFilterDto;
  @IsOptional() @IsObject() rules?: Record<string, unknown>;
  /** The audience being edited, so its own cycle check works before the first save. */
  @IsOptional() @IsString() @MaxLength(64) excludeId?: string;
}

export class AddMembersDto {
  @IsArray() @IsString({ each: true }) contactIds!: string[];
}
