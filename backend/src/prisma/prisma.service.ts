import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { tenancyExtension } from "../common/prisma-tenancy";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  // Underlying base client. NEVER expose this in normal service code — it
  // bypasses tenancy scoping. Reserved for admin/cross-tenant operations
  // (super-admin portal, migration scripts hosted in-process).
  private readonly base = new PrismaClient();
  private readonly client = this.base.$extends(tenancyExtension);

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /** Unscoped Prisma client. Use ONLY in code that must read/write across
   *  tenants (super-admin endpoints). Regular services must use the model
   *  delegates below, which go through the tenancy extension. */
  get raw(): PrismaClient {
    return this.base;
  }

  // ─── Model delegates (tenant-scoped via extension) ────────────────────
  get user() { return this.client.user; }
  get workspace() { return this.client.workspace; }
  get workspaceMember() { return this.client.workspaceMember; }
  get contact() { return this.client.contact; }
  get conversation() { return this.client.conversation; }
  get message() { return this.client.message; }
  get appointment() { return this.client.appointment; }
  get template() { return this.client.template; }
  get campaign() { return this.client.campaign; }
  get pipeline() { return this.client.pipeline; }
  get ticketStage() { return this.client.ticketStage; }
  get ticket() { return this.client.ticket; }
  get ticketActivity() { return this.client.ticketActivity; }
  get integration() { return this.client.integration; }
  get note() { return this.client.note; }
  get media() { return this.client.media; }
  get segment() { return this.client.segment; }

  get $transaction() { return this.client.$transaction.bind(this.client); }
  get $executeRawUnsafe() { return this.client.$executeRawUnsafe.bind(this.client); }
  get $queryRawUnsafe() { return this.client.$queryRawUnsafe.bind(this.client); }
  get $queryRaw() { return this.client.$queryRaw.bind(this.client); }
}
