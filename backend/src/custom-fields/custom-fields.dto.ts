import { Transform } from "class-transformer";
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Length } from "class-validator";

export const FIELD_TYPES = ["text", "number", "date", "select", "boolean"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CreateCustomFieldDto {
  @Transform(trim) @IsString() @Length(1, 80) label!: string;
  @Transform(trim) @IsString() @Length(1, 80) labelAr!: string;
  @IsIn([...FIELD_TYPES]) type!: FieldType;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
}

export class UpdateCustomFieldDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 80) label?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 80) labelAr?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
  @IsOptional() @IsInt() order?: number;
  // Present only so the service can reject it with a clear 400 (type is immutable).
  @IsOptional() @IsString() type?: string;
}

export class SetContactFieldsDto {
  @IsObject() values!: Record<string, unknown>;
}
