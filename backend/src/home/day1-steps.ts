import type { Day1Step, Day1StepKey } from "./home.dto";

/**
 * The Day-1 setup steps (pure). Each step's `done` is computed from data
 * (never stored); a step whose screen the member cannot use is omitted; the
 * services step exists only once SP-10 has shipped (ruling 11).
 */
export const DAY1_STEPS: { key: Day1StepKey; href: string; permission: string }[] = [
  { key: "connect_channel", href: "#/channels", permission: "channels.create" },
  { key: "add_knowledge", href: "#/settings?tab=aiKnowledge", permission: "knowledge.create" },
  { key: "invite_team", href: "#/settings?tab=members", permission: "members.create" },
  { key: "set_pipeline", href: "#/settings?tab=pipelines", permission: "pipelines.update" },
  { key: "add_services", href: "#/calendar?tab=services", permission: "bookings.manage" },
  { key: "first_reply", href: "#/inbox", permission: "conversations.create" },
];

export function day1View(
  done: Partial<Record<Day1StepKey, boolean>>,
  can: (permission: string) => boolean,
  opts: { dismissedAt: Date | null; hasServices: boolean },
): { show: boolean; steps: Day1Step[] } {
  const steps = DAY1_STEPS.filter((s) => can(s.permission) && (s.key !== "add_services" || opts.hasServices)).map((s) => ({
    key: s.key,
    done: !!done[s.key],
    href: s.href,
  }));
  const show = opts.dismissedAt === null && steps.length > 0 && steps.some((s) => !s.done);
  return { show, steps };
}
