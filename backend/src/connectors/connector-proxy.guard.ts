import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentLockService, paymentOverdue } from "../billing/payment-lock.service";
import { proxyTokenMatches, proxyTokenPrefix } from "./connector-proxy-token";

export type ProxyRequest = Request & { connector?: Record<string, unknown> & { id: string; workspaceId: string } };

/**
 * SP-23 proxy auth (Review Focus 1). The bearer `cnp_…` is looked up by its
 * prefix and bcrypt-compared; it must belong to `:connectorId`. Unknown,
 * foreign, revoked and disconnected all answer the same 404. No bearer is
 * 401. A payment-locked workspace gets `paymentOverdue()`; a failing lock
 * lookup propagates (fail closed, as McpAuthGuard).
 */
@Injectable()
export class ConnectorProxyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentLock: PaymentLockService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ProxyRequest>();
    const auth = req.headers["authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Bearer ")) throw new UnauthorizedException("Missing bearer token");
    const token = auth.slice(7).trim();
    const notFound = () => new NotFoundException({ statusCode: 404, message: "connectors.not_found" });
    const prefix = proxyTokenPrefix(token);
    if (!prefix) throw notFound();
    const row = await this.prisma.connector.findUnique({ where: { proxyTokenPrefix: prefix } });
    const id = String(req.params?.connectorId ?? "");
    if (!row || row.id !== id || row.status === "disconnected" || !(await proxyTokenMatches(token, row.proxyTokenHash))) throw notFound();
    if (await this.paymentLock.isLocked(row.workspaceId)) throw paymentOverdue();
    req.connector = row as ProxyRequest["connector"];
    return true;
  }
}
