// Pure mapping between the wizard's form state (two channel panels with a
// delay each) and the Automation.steps array the store persists. Keeping
// the persisted shape unchanged means the future backend model, the
// summarizer, and the tests all keep working.
import type { Lang } from "@/lib/types";
import { newStep, type Step, type WaitUnit } from "@/lib/automations";

export interface Delay {
  /** 0 means "immediately". */
  amount: number;
  unit: WaitUnit;
}

export interface ChannelDraft {
  on: boolean;
  templateId: string | null;
  /** Delay before this message, relative to the previous one (or the trigger). */
  delay: Delay;
  /** Email only; ignored for WhatsApp. */
  subject: string;
}

export interface MessagesDraft {
  whatsapp: ChannelDraft;
  email: ChannelDraft;
}

export const NO_DELAY: Delay = { amount: 0, unit: "hours" };

export const DELAY_PRESETS: readonly Delay[] = [
  NO_DELAY,
  { amount: 1, unit: "hours" },
  { amount: 1, unit: "days" },
  { amount: 2, unit: "days" },
  { amount: 3, unit: "days" },
  { amount: 7, unit: "days" },
];

export const CUSTOM_DELAY = "custom";

export const emptyChannel = (): ChannelDraft => ({
  on: false,
  templateId: null,
  delay: NO_DELAY,
  subject: "",
});

export const emptyMessages = (): MessagesDraft => ({ whatsapp: emptyChannel(), email: emptyChannel() });

export const delayKey = (d: Delay): string => (d.amount === 0 ? "0" : `${d.amount}${d.unit}`);

export function delayLabel(d: Delay, lang: Lang): string {
  if (d.amount === 0) return lang === "ar" ? "فوراً" : "Immediately";
  if (lang === "ar") return `بعد ${d.amount} ${d.unit === "days" ? "يوم" : "ساعة"}`;
  const unit = d.unit === "days" ? "day" : "hour";
  return `After ${d.amount} ${unit}${d.amount === 1 ? "" : "s"}`;
}

/** Read the first WhatsApp and first Email step (with the waits before them). */
export function messagesFromSteps(steps: Step[]): MessagesDraft {
  const m = emptyMessages();
  let pending: Delay = NO_DELAY;
  for (const s of steps) {
    if (s.kind === "wait") {
      pending = { amount: s.amount, unit: s.unit };
      continue;
    }
    const target = s.kind === "whatsapp" ? m.whatsapp : m.email;
    if (!target.on) {
      target.on = true;
      target.templateId = s.templateId;
      target.delay = pending;
      if (s.kind === "email") target.subject = s.subject;
    }
    pending = NO_DELAY;
  }
  return m;
}

/** Build the steps array, reusing ids from `prev` so React keys stay stable. */
export function stepsFromMessages(m: MessagesDraft, prev: Step[] = []): Step[] {
  const reuse = (kind: Step["kind"], skip: Set<string>): string | null => {
    const found = prev.find((s) => s.kind === kind && !skip.has(s.id));
    return found ? found.id : null;
  };
  const used = new Set<string>();
  const out: Step[] = [];

  const pushWait = (d: Delay) => {
    if (d.amount <= 0) return;
    const id = reuse("wait", used);
    const s = newStep("wait");
    if (s.kind === "wait") {
      s.amount = d.amount;
      s.unit = d.unit;
      if (id) s.id = id;
      used.add(s.id);
      out.push(s);
    }
  };

  if (m.whatsapp.on) {
    pushWait(m.whatsapp.delay);
    const id = reuse("whatsapp", used);
    const s = newStep("whatsapp");
    if (s.kind === "whatsapp") {
      s.templateId = m.whatsapp.templateId;
      if (id) s.id = id;
      used.add(s.id);
      out.push(s);
    }
  }
  if (m.email.on) {
    pushWait(m.email.delay);
    const id = reuse("email", used);
    const s = newStep("email");
    if (s.kind === "email") {
      s.templateId = m.email.templateId;
      s.subject = m.email.subject;
      if (id) s.id = id;
      used.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/** At least one channel is on and has a template. */
export const messagesReady = (m: MessagesDraft): boolean =>
  (m.whatsapp.on && m.whatsapp.templateId !== null) || (m.email.on && m.email.templateId !== null);
