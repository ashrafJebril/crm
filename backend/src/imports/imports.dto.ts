import { IsObject, IsOptional } from "class-validator";

export class PreviewImportDto {
  /** Header name -> target ("phone", "custom:<defId>", "ignore", ...). */
  @IsObject() mapping!: Record<string, string>;
  /** Shape-checked in the service (parseOptions). */
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}
