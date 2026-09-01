import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { WorkspaceRoles, WorkspaceRolesGuard } from "../common/workspace-roles.guard";
import type { WorkflowInput } from "./ai-workflows.client";
import { AiWorkflowsService } from "./ai-workflows.service";

@ValidatorConstraint({ name: "workflowConditionValue", async: false })
class WorkflowConditionValue implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    const condition = args.object as ConditionDto;
    if (condition.field === "services.ids") {
      return condition.op === "CONTAINS_ANY" && Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
    }
    return condition.op === "EQ" && typeof value === "string" && value.trim().length > 0;
  }
  defaultMessage() { return "condition value does not match its field/operator"; }
}

class ConditionDto {
  @IsIn(["branch.id", "booking.source", "services.ids"]) field!: string;
  @IsIn(["EQ", "CONTAINS_ANY"]) op!: string;
  @Validate(WorkflowConditionValue)
  value!: string | string[];
}

class ActionDto {
  @IsIn(["CUSTOMER_EMAIL", "STAFF_EMAIL"]) type!: string;
  @ValidateIf((o: ActionDto) => o.type === "STAFF_EMAIL")
  @IsArray() @ArrayMinSize(1) @IsEmail({}, { each: true }) recipients?: string[];
  @IsString() @MinLength(1) @MaxLength(200) subject!: string;
  @IsString() @MinLength(1) @MaxLength(20_000) body!: string;
}

export class WorkflowDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsBoolean() enabled!: boolean;
  @IsIn(["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"]) trigger!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConditionDto) conditions!: ConditionDto[];
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ActionDto) actions!: ActionDto[];
}
class PatchWorkflowDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"]) trigger?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ConditionDto) conditions?: ConditionDto[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ActionDto) actions?: ActionDto[];
}
class KillSwitchDto { @IsBoolean() enabled!: boolean; }

@Controller("ai/workflows")
export class AiWorkflowsController {
  constructor(private readonly service: AiWorkflowsService) {}

  @Get() list(@CurrentWorkspace() workspaceId: string) { return this.service.list(workspaceId); }

  @Post()
  @UseGuards(WorkspaceRolesGuard) @WorkspaceRoles("owner", "admin")
  create(@CurrentWorkspace() workspaceId: string, @Body() dto: WorkflowDto) {
    return this.service.create(workspaceId, dto as unknown as WorkflowInput);
  }

  @Patch(":id")
  @UseGuards(WorkspaceRolesGuard) @WorkspaceRoles("owner", "admin")
  update(@CurrentWorkspace() workspaceId: string, @Param("id") id: string, @Body() dto: PatchWorkflowDto) {
    return this.service.update(workspaceId, id, dto as unknown as Partial<WorkflowInput>);
  }

  @Delete(":id")
  @UseGuards(WorkspaceRolesGuard) @WorkspaceRoles("owner", "admin")
  delete(@CurrentWorkspace() workspaceId: string, @Param("id") id: string) { return this.service.delete(workspaceId, id); }

  @Post("preview")
  preview(@CurrentWorkspace() workspaceId: string, @Body() dto: WorkflowDto) {
    return this.service.preview(workspaceId, dto as unknown as WorkflowInput);
  }

  @Post("kill-switch")
  @UseGuards(WorkspaceRolesGuard) @WorkspaceRoles("owner", "admin")
  killSwitch(@CurrentWorkspace() workspaceId: string, @Body() dto: KillSwitchDto) {
    return this.service.setKillSwitch(workspaceId, dto.enabled);
  }

  @Get("runs") listRuns(@CurrentWorkspace() workspaceId: string) { return this.service.listRuns(workspaceId); }
  @Get("runs/:runId") getRun(@CurrentWorkspace() workspaceId: string, @Param("runId") runId: string) { return this.service.getRun(workspaceId, runId); }

  @Post("runs/:runId/retry")
  @UseGuards(WorkspaceRolesGuard) @WorkspaceRoles("owner", "admin")
  retry(@CurrentWorkspace() workspaceId: string, @Param("runId") runId: string) { return this.service.retryRun(workspaceId, runId); }
}
