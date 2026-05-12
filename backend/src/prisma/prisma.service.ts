import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { tenancyExtension } from "../common/prisma-tenancy";

function makeExtended() {
  const base = new PrismaClient();
  return base.$extends(tenancyExtension);
}

type ExtendedPrismaClient = ReturnType<typeof makeExtended>;

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly client: ExtendedPrismaClient = makeExtended();

  async onModuleDestroy(): Promise<void> {
    await (this.client as unknown as PrismaClient).$disconnect();
  }

  // ─── Model delegates ──────────────────────────────────────────────────
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
  get keyword() { return this.client.keyword; }
  get mention() { return this.client.mention; }
  get note() { return this.client.note; }

  get $transaction() { return this.client.$transaction.bind(this.client); }
}
