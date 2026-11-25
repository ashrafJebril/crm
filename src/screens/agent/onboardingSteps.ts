/**
 * SP-20 onboarding steps (pure): order, labels, the fixed assistant line of
 * each step (bilingual copy, never model text), progress, and what the setup
 * page and the "Continue setup" card show.
 */
import type { OnboardingState, OnboardingStep } from "@/lib/types";
import { ONBOARDING_STEPS } from "./agentConstants";

export const STEP_COPY: Record<OnboardingStep, { label: [string, string]; line: [string, string] }> = {
  business: {
    label: ["Your business", "نشاطك التجاري"],
    line: ["Hi! Let's set up your assistant. What's your business called?", "مرحبًا! لنُعدّ مساعدك. ما اسم نشاطك التجاري؟"],
  },
  website: {
    label: ["Website", "الموقع الإلكتروني"],
    line: [
      "What's your website? I'll read it to learn about your business. I only read the address you type.",
      "ما عنوان موقعك؟ سأقرؤه لأتعرّف على نشاطك. أقرأ العنوان الذي تكتبه فقط.",
    ],
  },
  learn: {
    label: ["What I learned", "ما تعلّمته"],
    line: [
      "Here's what I learned. Keep what's right; nothing is saved until you press Apply.",
      "هذا ما تعلّمته. أبقِ ما هو صحيح؛ لن يُحفظ شيء حتى تضغط تطبيق.",
    ],
  },
  try: {
    label: ["Try your agent", "جرّب وكيلك"],
    line: ["Try your agent: ask what a customer would ask.", "جرّب وكيلك: اسأل ما قد يسأله عميل."],
  },
  live: {
    label: ["Go live", "التشغيل"],
    line: ["All set. Your agent is ready.", "كل شيء جاهز. وكيلك جاهز للعمل."],
  },
};

export function stepIndex(step: OnboardingStep): number {
  return Math.max(0, (ONBOARDING_STEPS as readonly string[]).indexOf(step));
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const i = stepIndex(step);
  return i < ONBOARDING_STEPS.length - 1 ? (ONBOARDING_STEPS[i + 1] as OnboardingStep) : null;
}

/** "Step 2 of 5" numbers. */
export function progress(step: OnboardingStep): { current: number; total: number } {
  return { current: stepIndex(step) + 1, total: ONBOARDING_STEPS.length };
}

/** The "Continue setup" card shows only for a skipped onboarding the member can manage. */
export function showContinueCard(s: OnboardingState | null | undefined): boolean {
  return !!s && s.canManage && s.status === "skipped";
}

/** The setup page drives an in-progress onboarding; anything else shows a start or done state. */
/** "watching": another member is driving it (read-only, take over only when stuck). */
export type SetupView = "start" | "steps" | "watching" | "skipped" | "done" | "no_access";
export function setupView(s: OnboardingState | null | undefined): SetupView {
  if (!s) return "start";
  if (!s.canManage) return "no_access";
  if (s.status === "done") return "done";
  if (s.status === "skipped") return "skipped";
  if (s.status === "in_progress") return s.isStarter ? "steps" : "watching";
  return "start";
}

/** A crawl still running (poll while true). */
export function websiteReading(s: OnboardingState | null | undefined): boolean {
  const st = s?.website?.status;
  return st === "queued" || st === "processing" || st === "syncing";
}
