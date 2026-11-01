import { ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { isPaymentLocked } from "./payment-lock";

export const PAYMENT_OVERDUE = "PAYMENT_OVERDUE";
const TTL_MS = 60_000;

/** The one refusal every entry point (guard, login, SSO) returns. */
export function paymentOverdue(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: PAYMENT_OVERDUE,
    message: "This workspace is locked because payment is overdue",
  });
}

@Injectable()
export class PaymentLockService {
  // Per process; an entry may be up to TTL_MS stale in either direction.
  private readonly cache = new Map<string, { locked: boolean; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether the workspace is past its payment grace period. A failed lookup
   * throws (and is not cached): callers fail closed rather than unlock.
   */
  async isLocked(workspaceId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.cache.get(workspaceId);
    if (hit && now - hit.at < TTL_MS) return hit.locked;
    // raw: this runs before the request's workspace context exists.
    const ws = await this.prisma.raw.workspace.findUnique({
      where: { id: workspaceId },
      select: { paymentDueSince: true },
    });
    const locked = ws ? isPaymentLocked(ws.paymentDueSince, new Date(now)) : false;
    this.cache.set(workspaceId, { locked, at: now });
    return locked;
  }
}
