import { Transform } from "class-transformer";
import { IsArray, IsIn, IsOptional, IsString, Length } from "class-validator";

export const LABEL_COLORS = ["ink", "info", "ok", "warn", "bad", "accent", "human"] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CreateConversationLabelDto {
  @Transform(trim) @IsString() @Length(1, 40) name!: string;
  @IsIn([...LABEL_COLORS]) color!: (typeof LABEL_COLORS)[number];
}

export class UpdateConversationLabelDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 40) name?: string;
  @IsOptional() @IsIn([...LABEL_COLORS]) color?: (typeof LABEL_COLORS)[number];
}

export class SetConversationLabelsDto {
  @IsArray() @IsString({ each: true }) labelIds!: string[];
}
