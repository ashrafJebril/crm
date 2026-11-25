/**
 * SP-21 FAQ model. Pure. Mirrors the backend's duplicate rule (trimmed,
 * whitespace collapsed, case-folded) so the editor can warn before saving,
 * and computes the order a drag or keyboard move produces.
 */

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  order: number;
  version: number;
}

export function questionKey(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Another FAQ already asks this question (ignoring `exceptId`). */
export function isDuplicateQuestion(question: string, faqs: Pick<FaqItem, "id" | "question">[], exceptId?: string): boolean {
  const key = questionKey(question);
  if (!key) return false;
  return faqs.some((f) => f.id !== exceptId && questionKey(f.question) === key);
}

/** Move the item at `from` to `to` (both clamped); returns the new id order. */
export function moveId(ids: string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const target = Math.max(0, Math.min(ids.length - 1, to));
  const out = [...ids];
  const [id] = out.splice(from, 1);
  out.splice(target, 0, id);
  return out;
}

/** Move one id up (-1) or down (+1); unchanged at the ends. */
export function moveBy(ids: string[], id: string, delta: -1 | 1): string[] {
  const at = ids.indexOf(id);
  return at < 0 ? [...ids] : moveId(ids, at, at + delta);
}

/** Whether an order differs from the saved one (a reorder to send). */
export function orderChanged(before: string[], after: string[]): boolean {
  return before.length !== after.length || before.some((id, i) => after[i] !== id);
}

/** FAQs matching a search (question or answer, case-insensitive). */
export function filterFaqs<T extends Pick<FaqItem, "question" | "answer">>(faqs: T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return faqs;
  return faqs.filter((f) => f.question.toLocaleLowerCase().includes(q) || f.answer.toLocaleLowerCase().includes(q));
}
