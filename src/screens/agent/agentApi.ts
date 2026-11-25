import { api } from "@/api/client";
import type { AgentResync, AgentSettings, LearnApplyResult, OnboardingState, SandboxReply, SandboxThread } from "@/lib/types";
import type { WeeklySchedule } from "@/screens/calendar/schedule";

/** SP-20 routes (backend/src/agent). */

export const SETTINGS_PATH = "/agent/settings";
export const SANDBOX_PATH = "/agent/sandbox";
export const ONBOARDING_PATH = "/onboarding";

export interface AgentSettingsPatch {
  identity?: { nameEn?: string; nameAr?: string; greeting?: string; greetingAr?: string; tone?: string[] };
  hours?: { mode: AgentSettings["hoursMode"]; schedule?: WeeklySchedule };
  audience?: { excludedTagIds: string[] };
  version: number;
}

export const patchAgentSettings = (body: AgentSettingsPatch) => api.patch<AgentSettings>(SETTINGS_PATH, body);
export const resyncAgent = () => api.post<AgentResync>(`${SETTINGS_PATH}/resync`);

export const sendSandboxMessage = (message: string) => api.post<SandboxReply>(`${SANDBOX_PATH}/messages`, { message });
export const resetSandbox = () => api.delete<{ ok: true }>(SANDBOX_PATH);
export const getSandbox = () => api.get<SandboxThread>(SANDBOX_PATH);

export type OnboardingAction = "start" | "skip" | "resume" | "step" | "finish" | "takeover" | "reset";
export const patchOnboarding = (body: { action: OnboardingAction; step?: string; businessName?: string }) =>
  api.patch<OnboardingState>(ONBOARDING_PATH, body);
export const onboardingWebsite = (url: string) => api.post<OnboardingState>(`${ONBOARDING_PATH}/website`, { url });
export const onboardingLearn = () => api.post<OnboardingState>(`${ONBOARDING_PATH}/learn`);
export const applyLearned = (body: { description?: "replace" | "append" | "skip"; faqs?: number[]; hours?: boolean }) =>
  api.post<LearnApplyResult>(`${ONBOARDING_PATH}/learn/apply`, body);
