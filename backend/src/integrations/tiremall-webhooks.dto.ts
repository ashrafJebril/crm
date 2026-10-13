import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export class TiremallCustomerDto {
  @IsString() @IsNotEmpty() id!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsString() city?: string | null;
  @IsOptional() @IsNumber() totalOrders?: number;
  @IsOptional() @IsNumber() totalSpent?: number;
}

export class TiremallCustomersWebhookDto {
  @IsIn(["customer.upserted", "customer.deleted"])
  event!: "customer.upserted" | "customer.deleted";

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TiremallCustomerDto)
  customers!: TiremallCustomerDto[];
}
