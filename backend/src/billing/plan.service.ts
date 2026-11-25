import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const TTL_MS = 60_000;

/**
 * The workspace's effective plan: `Workspace.plan`, which Kewy pushes (the
 * package name) unless a super-admin overrode it (R8). Cached per process for
 * 60 s, like PaymentLockService. A failed lookup throws (not cached).
 */
@Injectable()
export class PlanService {
  private readonly cache = new Map<string, { plan: string; overridden: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async planOf(workspaceId: string): Promise<{ plan: string; overridden: boolean }> {
    const now = Date.now();
    const hit = this.cache.get(workspaceId);
    if (hit && now - hit.at < TTL_MS) return { plan: hit.plan, overridden: hit.overridden };
    // raw: guards run before the request's workspace context exists.
    const ws = await this.prisma.raw.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true, planOverriddenAt: true } });
    const out = { plan: ws?.plan ?? "free", overridden: !!ws?.planOverriddenAt };
    this.cache.set(workspaceId, { ...out, at: now });
    return out;
  }

  /** After an admin override or a Kewy push. */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}
