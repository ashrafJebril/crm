import { Body, Controller, Get, Patch, Post } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { CurrentViewer, CurrentWorkspace } from "../../common/current-workspace.decorator";
import type { Viewer } from "../../permissions/visibility";
import { LEARN_FAQS_MAX } from "../agent-constants";
import { ONBOARDING_ACTIONS, type OnboardingAction } from "./onboarding-state";
import { OnboardingService } from "./onboarding.service";

export class PatchOnboardingDto {
  @IsIn(ONBOARDING_ACTIONS as unknown as string[]) action!: OnboardingAction;
  /** Checked against ONBOARDING_STEPS in the service (400 `onboarding.step_invalid`). */
  @IsOptional() @IsString() step?: string;
  /** Trimmed and length-checked in the service (400 `onboarding.name_invalid`). */
  @IsOptional() @IsString() businessName?: string;
}

export class OnboardingWebsiteDto {
  /** Validated by SP-21's website check (public http(s) URL). */
  @IsString() url!: string;
}

export class ApplyLearnDto {
  @IsOptional() @IsIn(["replace", "append", "skip"]) description?: "replace" | "append" | "skip";
  @IsOptional() @IsArray() @ArrayMaxSize(LEARN_FAQS_MAX) @IsInt({ each: true }) @Min(0, { each: true }) faqs?: number[];
  @IsOptional() @IsBoolean() hours?: boolean;
}

/**
 * SP-20 onboarding. `GET /onboarding` is open to every member (it says
 * whether the caller can manage it); the rest is `settings.update`
 * (permission-map.ts), and the service also checks the starter and, for
 * Apply, the permission of each part it writes.
 */
@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly svc: OnboardingService) {}

  @Get()
  get(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.get(ws, viewer);
  }

  @Patch()
  patch(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Body() dto: PatchOnboardingDto) {
    return this.svc.patch(ws, viewer, dto);
  }

  @Post("website")
  website(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Body() dto: OnboardingWebsiteDto) {
    return this.svc.website(ws, viewer, dto);
  }

  @Post("learn")
  learn(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer) {
    return this.svc.learn(ws, viewer);
  }

  @Post("learn/apply")
  apply(@CurrentWorkspace() ws: string, @CurrentViewer() viewer: Viewer, @Body() dto: ApplyLearnDto) {
    return this.svc.apply(ws, viewer, dto);
  }
}
