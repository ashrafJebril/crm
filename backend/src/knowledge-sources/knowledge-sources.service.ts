import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import { KB_BATCH_MAX } from "./knowledge-constants";
import { knowledgeError } from "./knowledge-errors";
import type { KnowledgePageDto, KnowledgePreviewDto, KnowledgeSourceDto } from "./knowledge-sources.dto";
import { crmTemplate, isTypedKind, LKnowledge, toCrm, toLKind, type LSource } from "./l-knowledge";

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

type LList = { items: LSource[] };

/**
 * The business's knowledge, stored and processed on l (see l-knowledge.ts).
 * Same methods and shapes as before, so the screens, Copilot and onboarding
 * did not change. A workspace whose AI agent is off lists nothing and gets
 * 409 `knowledge.agent_off` for a change.
 */
@Injectable()
export class KnowledgeSourcesService {
  constructor(private readonly l: LKnowledge) {}

  async list(workspaceId: string, q: { kind?: string; status?: string } = {}): Promise<{ items: KnowledgeSourceDto[]; agentOn: boolean }> {
    const t = await this.l.target(workspaceId);
    if (!t) return { items: [], agentOn: false };
    const qs = new URLSearchParams();
    if (q.kind) qs.set("kind", toLKind(q.kind));
    if (q.status) qs.set("status", q.status);
    const s = qs.toString();
    const res = await this.l.call<LList>(t, `/sources${s ? `?${s}` : ""}`);
    return { items: res.items.map(toCrm), agentOn: true };
  }

  async get(workspaceId: string, id: string): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, `/sources/${enc(id)}`));
  }

  async preview(workspaceId: string, id: string): Promise<KnowledgePreviewDto> {
    const t = await this.l.require(workspaceId);
    return this.l.call<KnowledgePreviewDto>(t, `/sources/${enc(id)}/preview`);
  }

  async pages(workspaceId: string, id: string, q: { state?: string; cursor?: string } = {}): Promise<{ items: KnowledgePageDto[]; nextCursor: string | null }> {
    const t = await this.l.require(workspaceId);
    const qs = new URLSearchParams();
    if (q.state) qs.set("state", q.state);
    if (q.cursor) qs.set("cursor", q.cursor);
    const s = qs.toString();
    return this.l.call(t, `/sources/${enc(id)}/pages${s ? `?${s}` : ""}`);
  }

  async sendFile(workspaceId: string, id: string, res: Response): Promise<void> {
    const t = await this.l.require(workspaceId);
    const f = await this.l.raw(t, `/sources/${enc(id)}/file`);
    res.setHeader("Content-Type", f.contentType ?? "application/octet-stream");
    if (f.disposition) res.setHeader("Content-Disposition", f.disposition);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(f.data);
  }

  async remove(workspaceId: string, id: string): Promise<{ ok: true }> {
    const t = await this.l.require(workspaceId);
    await this.l.call(t, `/sources/${enc(id)}`, { method: "DELETE" });
    return { ok: true };
  }

  async reprocess(workspaceId: string, id: string): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, `/sources/${enc(id)}/reprocess`, { method: "POST" }));
  }

  async putContent(workspaceId: string, _userId: string | null, body: { bodyJson: unknown; version: number }): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, "/content", { method: "PUT", body: { bodyJson: body.bodyJson, version: body.version } }));
  }

  /** The guidelines of the workspace's agent (null when there are none yet). */
  async getGuidelines(workspaceId: string): Promise<KnowledgeSourceDto | null> {
    const t = await this.l.target(workspaceId);
    if (!t) return null;
    const agent = await this.l.agentSlug(workspaceId, t);
    const res = await this.l.call<LSource | null>(t, `/guidelines?agent=${enc(agent)}`);
    return res ? toCrm(res) : null;
  }

  async putGuidelines(workspaceId: string, _userId: string | null, body: { body: string; version: number }): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    const agent = await this.l.agentSlug(workspaceId, t);
    return toCrm(await this.l.call<LSource>(t, "/guidelines", { method: "PUT", body: { agent, body: body.body, version: body.version } }));
  }

  async createFaq(workspaceId: string, _userId: string | null, body: { question: string; answer: string }): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, "/faqs", { method: "POST", body: { question: body.question, answer: body.answer } }));
  }

  async patchFaq(workspaceId: string, id: string, body: { question?: string; answer?: string; version: number }): Promise<KnowledgeSourceDto> {
    const t = await this.l.require(workspaceId);
    return toCrm(await this.l.call<LSource>(t, `/faqs/${enc(id)}`, { method: "PATCH", body }));
  }

  async reorderFaqs(workspaceId: string, body: { ids: string[] }): Promise<{ items: KnowledgeSourceDto[] }> {
    const t = await this.l.require(workspaceId);
    const res = await this.l.call<LList>(t, "/faqs/reorder", { method: "POST", body: { ids: body.ids } });
    return { items: res.items.map(toCrm) };
  }

  /**
   * Files to l (it checks type, size and signature, and reads them). A
   * `typedKind` sends crm's template for it, so l checks the columns and rows.
   */
  async uploadFiles(
    workspaceId: string,
    _userId: string | null,
    files: UploadedFile[],
    opts: { typedKind?: unknown; acceptValidRows?: unknown } = {},
  ): Promise<{ items: KnowledgeSourceDto[] }> {
    if (!files?.length) throw knowledgeError("knowledge.file_type", { fileName: null });
    if (files.length > KB_BATCH_MAX) throw knowledgeError("knowledge.batch_too_large", { max: KB_BATCH_MAX });
    let typedKind: string | null = null;
    if (opts.typedKind !== undefined && opts.typedKind !== null && opts.typedKind !== "") {
      if (!isTypedKind(opts.typedKind)) throw knowledgeError("knowledge.file_type", { field: "typedKind" });
      typedKind = opts.typedKind;
    }
    const t = await this.l.require(workspaceId);
    const fd = new FormData();
    for (const f of files) fd.append("files", new Blob([new Uint8Array(f.buffer)], { type: f.mimetype }), f.originalname);
    if (typedKind && isTypedKind(typedKind)) fd.append("template", JSON.stringify(crmTemplate(typedKind)));
    if (opts.acceptValidRows === true || opts.acceptValidRows === "true") fd.append("acceptValidRows", "true");
    const res = await this.l.call<LList>(t, "/files", { method: "POST", formData: fd, timeoutMs: 120_000 });
    return { items: res.items.map(toCrm) };
  }
}

function enc(id: string): string {
  return encodeURIComponent(String(id ?? ""));
}
