import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LJoteckClient } from "./l-joteck.client";

export interface LDocument {
  id: string;
  title: string;
  source_type: string;
  status: string;
  meta: Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class LKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
  ) {}

  private async requireLWorkspaceId(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return ws?.lWorkspaceId ?? null;
  }

  async list(workspaceId: string): Promise<{ connected: boolean; documents: LDocument[] }> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) return { connected: false, documents: [] };
    const documents = await this.client.request<LDocument[]>(`/workspaces/${lWorkspaceId}/documents`);
    return { connected: true, documents };
  }

  async upload(workspaceId: string, file: Express.Multer.File): Promise<LDocument> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.buffer)]), file.originalname);
    return this.client.request<LDocument>(`/workspaces/${lWorkspaceId}/documents`, {
      method: "POST",
      formData: form,
    });
  }

  async remove(workspaceId: string, documentId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    await this.client.request<void>(`/workspaces/${lWorkspaceId}/documents/${documentId}`, {
      method: "DELETE",
    });
  }
}
