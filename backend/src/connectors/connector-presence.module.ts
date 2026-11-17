import { Module } from "@nestjs/common";
import { CONNECTOR_PRESENCE } from "../skills/connector-presence";
import { ConnectorPresenceService } from "./connector-presence.service";

/**
 * SP-23: binds SP-22's CONNECTOR_PRESENCE to the real presence. A leaf
 * module (it imports nothing; Prisma is global), so SkillsModule can import
 * it while ConnectorsModule imports SkillsModule: no module cycle.
 */
@Module({
  providers: [ConnectorPresenceService, { provide: CONNECTOR_PRESENCE, useExisting: ConnectorPresenceService }],
  exports: [CONNECTOR_PRESENCE, ConnectorPresenceService],
})
export class ConnectorPresenceModule {}
