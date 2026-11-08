import { IsIn, IsObject, IsOptional, IsString } from "class-validator";

export const IMPORT_KINDS = ["contacts", "audience"] as const;

export class CreateImportDto {
  @IsString() @IsIn(IMPORT_KINDS as unknown as string[]) kind!: string;
}

export class PreviewImportDto {
  /** Header name -> target ("phone", "custom:<defId>", "ignore", ...). */
  @IsObject() mapping!: Record<string, string>;
  /** Shape-checked in the service (parseOptions). */
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}
