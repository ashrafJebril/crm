import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export const PIPELINE_KINDS = ["deals", "leads"] as const;

export class CreatePipelineDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() nameAr!: string;
  @IsOptional() @IsIn(PIPELINE_KINDS as unknown as string[]) kind?: "deals" | "leads";
}

export class ListPipelinesQuery {
  /** "1" / "true" include archived pipelines (settings screen only). */
  @IsOptional() @IsString() includeArchived?: string;
}

export class DraftStageDto {
  @IsOptional() @IsString() id?: string;
  @IsString() label!: string;
  @IsString() labelAr!: string;
  @IsString() color!: string;
  @IsInt() order!: number;
  @IsOptional() @IsInt() slaMinutes?: number | null;
  @IsBoolean() isWon!: boolean;
  @IsBoolean() isTerminal!: boolean;
}

export class RemovedStageDto {
  @IsString() stageId!: string;
  @IsOptional() @IsString() moveTo?: string | null;
}

export class DraftLostReasonDto {
  @IsOptional() @IsString() id?: string;
  @IsString() label!: string;
  @IsString() labelAr!: string;
  @IsInt() order!: number;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class SavePipelineDraftDto {
  @IsInt() version!: number;
  @IsString() name!: string;
  @IsString() nameAr!: string;
  @IsOptional() @IsInt() staleDays?: number | null;
  @IsBoolean() agentCanMove!: boolean;
  @IsBoolean() assignsConversations!: boolean;

  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DraftStageDto)
  stages!: DraftStageDto[];

  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => RemovedStageDto)
  removed!: RemovedStageDto[];

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => DraftLostReasonDto)
  lostReasons!: DraftLostReasonDto[];
}
