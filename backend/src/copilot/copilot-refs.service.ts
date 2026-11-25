/**
 * SP-18 `@` references (Review Focus 1). Each `{kind, id}` is read through
 * SP-06 `RecordsService.get(ws, viewer, kind, id)` as the member, which is
 * `canOpenRecord` (role `<resource>.view` plus conversation visibility) and
 * answers 404 for no access, a foreign workspace or a missing id alike. Any
 * failure refuses the WHOLE message with 403 `copilot.ref_not_permitted
 * {index}` before a model call. A permitted reference reaches the model as
 * `{kind, id, title, fields}` (data, in the per-turn system message).
 */
import { Injectable } from "@nestjs/common";
import type { Viewer } from "../permissions/visibility";
import { RecordsService, type RecordField } from "../records/records.service";
import { MAX_REFS, REF_KINDS, type RefKind } from "./copilot-constants";
import { copilotError } from "./copilot-errors";

/** Copilot reference kinds → SP-06 record kinds. */
export const REF_RECORD_KIND: Record<RefKind, string> = { contact: "contact", ticket: "ticket", booking: "booking" };

export interface ResolvedRef {
  kind: RefKind;
  id: string;
  title: string;
  fields: RecordField[];
}

@Injectable()
export class CopilotRefsService {
  constructor(private readonly records: RecordsService) {}

  async resolve(workspaceId: string, viewer: Viewer, refs: { kind: string; id: string }[] | undefined): Promise<ResolvedRef[]> {
    const list = refs ?? [];
    if (list.length > MAX_REFS) throw copilotError("copilot.too_many_refs", { max: MAX_REFS });
    const out: ResolvedRef[] = [];
    for (let index = 0; index < list.length; index++) {
      const { kind, id } = list[index];
      if (!(REF_KINDS as readonly string[]).includes(kind) || typeof id !== "string" || !id) {
        throw copilotError("copilot.ref_not_permitted", { index });
      }
      try {
        const r = await this.records.get(workspaceId, viewer, REF_RECORD_KIND[kind as RefKind], id);
        out.push({ kind: kind as RefKind, id: r.id, title: r.title, fields: r.fields });
      } catch {
        throw copilotError("copilot.ref_not_permitted", { index });
      }
    }
    return out;
  }
}
