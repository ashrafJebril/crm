import { IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

export class ConnectWhatsAppDto {
  // Meta-issued phone-number id (NOT the phone number itself). Found under
  // WhatsApp → API Setup → "From" → Phone number ID.
  @IsString()
  @IsNotEmpty()
  phoneNumberId!: string;

  // WhatsApp Business Account id (WABA id). Same WhatsApp → API Setup page.
  @IsString()
  @IsNotEmpty()
  wabaId!: string;

  // System-user (or temporary 24-hour) access token from Meta.
  @IsString()
  @MinLength(20, { message: "Token looks too short to be a Meta access token" })
  accessToken!: string;

  // Verify token chosen by us. We echo this back on Meta's GET handshake.
  // Anything reasonable — paste the same string into Meta's webhook setup.
  @IsString()
  @IsNotEmpty()
  verifyToken!: string;

  // Human-friendly label for the connected number (e.g. "+966 5x xxx xxxx").
  @IsOptional()
  @IsString()
  displayPhoneNumber?: string;
}

export class ConnectByTokenDto {
  @IsString()
  @MinLength(20, { message: "Token looks too short to be a Meta access token" })
  accessToken!: string;
}

export class SendWhatsAppDto {
  // Allow empty when an image attachment is present (caption-only sends).
  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  mediaId?: string;
}

export class SendWhatsAppTemplateDto {
  // Meta template name (e.g. "order_shipped"). Must already be APPROVED on
  // the WABA — Meta rejects unknown / pending templates synchronously.
  @IsString()
  @IsNotEmpty()
  name!: string;

  // BCP-47-ish language code Meta expects (e.g. "en_US", "ar"). Must match
  // exactly what the template was approved under.
  @IsString()
  @IsNotEmpty()
  language!: string;

  // Variables for the BODY component. Pass an empty array for templates
  // with no `{{1}}, {{2}}, …` placeholders.
  @IsOptional()
  variables?: string[];
}

export class TestSendWhatsAppDto {
  // E.164 WhatsApp id of the recipient (digits only, no '+'). In sandbox this
  // must be one of the allow-listed numbers added in Meta's WhatsApp → API Setup.
  @IsString()
  @IsNotEmpty()
  to!: string;

  @IsString()
  @IsNotEmpty()
  message!: string;
}
