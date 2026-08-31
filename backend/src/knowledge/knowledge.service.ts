import { Injectable } from "@nestjs/common";
import {
  KnowledgeClient,
  type KewyKnowledgeDoc,
  type KewyKnowledgeKind,
  type KewySaveDocResult,
  type KewySyncResult,
} from "./knowledge.client";

/**
 * The tenant boundary.
 *
 * Every method here takes `workspaceId` as its FIRST argument and derives the
 * upstream `tenantId` from it. Nothing accepts a tenantId, so no code path —
 * present or future — can be handed one from a request body. That is the whole
 * security model of this module in one sentence.
 */
@Injectable()
export class KnowledgeService {
  constructor(private readonly client: KnowledgeClient) {}

  /**
   * CRM workspaceId -> kewy-ai tenantId.
   *
   * Today these are the same string (the live salon is cmpayevw8000011v0tgyu6rz1
   * in both systems), which is exactly why this function exists rather than the
   * value being passed straight through: the identity is a coincidence of how
   * the tenant was provisioned, not a contract. When kewy-ai is sold to a
   * workspace that was created separately, this becomes a lookup and every
   * call site is already routed through it.
   */
  private tenantIdFor(workspaceId: string): string {
    return workspaceId;
  }

  async listDocs(workspaceId: string): Promise<{ docs: KewyKnowledgeDoc[] }> {
    const { docs } = await this.client.listDocs(this.tenantIdFor(workspaceId));
    // Owner-authored first, then synced: the editable ones are what this screen
    // is for, and the three auto-synced docs would otherwise bury them.
    const sorted = [...docs].sort((a, b) => {
      if (a.editable !== b.editable) return a.editable ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return { docs: sorted };
  }

  async saveDoc(
    workspaceId: string,
    input: { id?: string; title: string; body: string; kind: KewyKnowledgeKind },
  ): Promise<KewySaveDocResult> {
    return this.client.upsertDoc({
      // Stamped from the session. Note the argument order: even if `input` ever
      // grew a stray tenantId it could not reach the wire, because the DTO
      // does not declare one and Nest's global ValidationPipe runs with
      // forbidNonWhitelisted — an unknown key is a 400, not a silent pass.
      tenantId: this.tenantIdFor(workspaceId),
      id: input.id,
      title: input.title,
      body: input.body,
      kind: input.kind,
    });
  }

  async deleteDoc(workspaceId: string, id: string): Promise<{ ok: true; id: string }> {
    return this.client.deleteDoc(this.tenantIdFor(workspaceId), id);
  }

  async sync(workspaceId: string): Promise<KewySyncResult> {
    return this.client.sync(this.tenantIdFor(workspaceId));
  }
}
