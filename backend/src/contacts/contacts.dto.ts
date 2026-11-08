import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

const cleanEmail = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

export class CreateContactDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @Transform(cleanEmail) @IsEmail() email?: string;
  @IsOptional() @IsString() ownerId?: string | null;
  @IsOptional() @IsBoolean() marketingOptOut?: boolean;
  @IsOptional() @IsBoolean() notALead?: boolean;
  @IsOptional() @IsString() phone?: string;
  @IsString() @IsNotEmpty() industry!: string;
  @IsString() @IsNotEmpty() lifecycle!: string;
  @IsString() @IsNotEmpty() source!: string;
  @IsOptional() @IsString() value?: string;
  @IsOptional() @IsString() lastSeen?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsInt() @Min(0) convs?: number;
}

export class UpdateContactDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @Transform(cleanEmail) @IsEmail() email?: string;
  @IsOptional() @IsString() ownerId?: string | null;
  @IsOptional() @IsBoolean() marketingOptOut?: boolean;
  @IsOptional() @IsBoolean() notALead?: boolean;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() lifecycle?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() value?: string;
  @IsOptional() @IsString() lastSeen?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsInt() @Min(0) convs?: number;
}

export const BULK_OPS = [
  "addTags",
  "removeTags",
  "addToGroup",
  "setOwner",
  "setOptOut",
  "setNotALead",
  "addToPipeline",
  "delete",
] as const;
export type BulkOp = (typeof BULK_OPS)[number];

/** Select-all resolves at most this many ids (matches SELECT_ALL_CAP). */
export const BULK_IDS_CAP = 10_000;

/** Flat body for POST /contacts/bulk; the service checks op-specific fields. */
export class BulkContactsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(BULK_IDS_CAP) @IsString({ each: true }) ids?: string[];
  /** Shared ContactListFilter (same keys as the query params, JSON-typed). */
  @IsOptional() @IsObject() filter?: Record<string, unknown>;
  @IsIn(BULK_OPS as unknown as string[]) op!: BulkOp;
  @IsOptional() @IsArray() @IsString({ each: true }) names?: string[];
  @IsOptional() @IsString() segmentId?: string;
  @IsOptional() @IsString() ownerId?: string | null;
  @IsOptional() @IsBoolean() value?: boolean;
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsBoolean() force?: boolean;
}
