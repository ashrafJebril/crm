import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const TTL_MS = 30_000;

/**
 * SP-26 ruling 4: `User.sessionVersion` is carried as `sv` in the JWT and
 * compared by AuthGuard. Reads go through a 30 s per-process cache (one
 * indexed read per user per 30 s); a bump invalidates in-process, other
 * processes catch up within 30 s (accepted). Tokens without `sv` read as 0.
 */
@Injectable()
export class SessionVersionService {
  private readonly cache = new Map<string, { value: number | null; expires: number }>();
  now: () => number = () => Date.now();

  constructor(private readonly prisma: PrismaService) {}

  /** The user's current version, or null when the user no longer exists. */
  async current(userId: string): Promise<number | null> {
    const hit = this.cache.get(userId);
    if (hit && hit.expires > this.now()) return hit.value;
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
    const value = row ? (row.sessionVersion ?? 0) : null;
    this.cache.set(userId, { value, expires: this.now() + TTL_MS });
    return value;
  }

  /** True when a token's `sv` still matches. */
  async isCurrent(userId: string, sv: number | undefined): Promise<boolean> {
    const cur = await this.current(userId);
    return cur !== null && (sv ?? 0) === cur;
  }

  /** Prisma `data` fragment that ends every existing session. */
  static bump(): { sessionVersion: { increment: number } } {
    return { sessionVersion: { increment: 1 } };
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}
