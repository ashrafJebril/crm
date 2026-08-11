import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

const STATUSES = ["confirmed", "pending", "completed", "cancelled", "no-show"] as const;
const SOURCES = ["human", "self-booking"] as const;

export class CreateAppointmentDto {
  @IsString() @IsNotEmpty() contactId!: string;
  @IsString() @IsNotEmpty() service!: string;
  @IsString() @IsNotEmpty() serviceAr!: string;
  @IsDateString() startAt!: string;
  @IsInt() @Min(1) durationMin!: number;
  @IsIn([...STATUSES]) status!: (typeof STATUSES)[number];
  @IsIn([...SOURCES]) source!: (typeof SOURCES)[number];
  @IsOptional() @IsString() staffId?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() noteAr?: string;
  @IsOptional() @IsBoolean() reminderSent?: boolean;
}

export class UpdateAppointmentDto {
  @IsOptional() @IsString() service?: string;
  @IsOptional() @IsString() serviceAr?: string;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsInt() @Min(1) durationMin?: number;
  @IsOptional() @IsIn([...STATUSES]) status?: (typeof STATUSES)[number];
  @IsOptional() @IsIn([...SOURCES]) source?: (typeof SOURCES)[number];
  @IsOptional() @IsString() staffId?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() noteAr?: string;
  @IsOptional() @IsBoolean() reminderSent?: boolean;
}
