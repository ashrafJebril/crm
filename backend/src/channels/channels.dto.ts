import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from "class-validator";

/** `POST /channels`: web chat only. WhatsApp (T4), Telegram (T2) and the
 *  Zernio platforms have their own connect flows. */
export class CreateChannelDto {
  @IsIn(["webchat"]) kind!: "webchat";
  @IsString() @IsNotEmpty() @MaxLength(80) displayName!: string;
  @IsOptional() @IsObject() config?: Record<string, unknown>;
}

/** `POST /channels/telegram`. The token's shape is checked in the service
 *  (400 channels.telegram_invalid_token); it is never echoed back. */
export class ConnectTelegramDto {
  @IsString() @IsNotEmpty() @MaxLength(200) botToken!: string;
  @IsOptional() @IsString() @MaxLength(80) displayName?: string;
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

/** `POST /channels/whatsapp/embedded-signup`: what Meta's popup hands the
 *  page (the `code` from FB.login, `waba_id` / `phone_number_id` and the
 *  event from the WA_EMBEDDED_SIGNUP session message). Coexistence events
 *  are out of scope (R6), so only FINISH / FINISH_ONLY_WABA are accepted. */
export class EmbeddedSignupDto {
  @IsString() @IsNotEmpty() @MaxLength(2048) code!: string;
  @IsOptional() @IsString() @Matches(/^\d{1,32}$/) wabaId?: string;
  @IsOptional() @IsString() @Matches(/^\d{1,32}$/) phoneNumberId?: string;
  @IsOptional() @IsIn(["FINISH", "FINISH_ONLY_WABA"]) signupEvent?: "FINISH" | "FINISH_ONLY_WABA";
  @IsOptional() @IsString() @MaxLength(80) displayName?: string;
}

/** `POST /channels/whatsapp/manual`: the old connect-by-token flow, now
 *  adding a channel. `phoneNumberId` picks one of the token's numbers. */
export class ManualWhatsappDto {
  @IsString() @IsNotEmpty() @MaxLength(1024) accessToken!: string;
  @IsOptional() @IsString() @Matches(/^\d{1,32}$/) phoneNumberId?: string;
}

/* Landline steps. Field formats are checked in LandlineService so each
 * failure names its field (400 channels.landline_invalid_input {field}). */
export class LandlineNumberDto {
  @IsString() @MaxLength(8) cc!: string;
  @IsString() @MaxLength(32) phoneNumber!: string;
  @IsString() @MaxLength(120) verifiedName!: string;
}

export class LandlineRequestCodeDto {
  @IsString() @MaxLength(8) method!: "SMS" | "VOICE";
  @IsOptional() @IsString() @MaxLength(8) language?: string;
}

export class LandlineVerifyDto {
  @IsString() @MaxLength(16) code!: string;
}
