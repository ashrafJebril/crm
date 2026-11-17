import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/** POST /webhooks. Events and the URL policy are checked by the service. */
export class CreateWebhookDto {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsArray()
  @IsString({ each: true })
  events!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}

/** PATCH /webhooks/:id. `url` is accepted only to answer 400
 *  webhooks.url_immutable (instead of a generic whitelist error). */
export class UpdateWebhookDto {
  @IsOptional()
  url?: unknown;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
