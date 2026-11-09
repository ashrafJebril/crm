import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

/** `POST /channels`: web chat only. WhatsApp (T4), Telegram (T2) and the
 *  Zernio platforms have their own connect flows. */
export class CreateChannelDto {
  @IsIn(["webchat"]) kind!: "webchat";
  @IsString() @IsNotEmpty() @MaxLength(80) displayName!: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}

/** `PATCH /channels/:id`. */
export class UpdateChannelDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) displayName?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}

/** `GET /channels/limits`. `secretsEncryption` only for channels.update holders. */
export interface ChannelLimitsDto {
  whatsapp: { used: number; limit: number; plan: string };
  secretsEncryption?: "on" | "off";
}
