import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

export class CreateContactDto {
  @IsString() @IsNotEmpty() name!: string;
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
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() lifecycle?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsString() value?: string;
  @IsOptional() @IsString() lastSeen?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsInt() @Min(0) convs?: number;
}
