import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { SkillsModule } from "../skills/skills.module";
import { ConnectorAgentService } from "./connector-agent.service";
import { ConnectorCallPruneScheduler } from "./connector-call-prune.scheduler";
import { ConnectorCallRecorder } from "./connector-call.recorder";
import { ConnectorCredentials } from "./connector-credentials";
import { ConnectorProxyController } from "./connector-proxy.controller";
import { ConnectorProxyGuard } from "./connector-proxy.guard";
import { ConnectorProxyRpc } from "./connector-proxy.rpc";
import { CONNECTOR_UPSTREAM, HttpConnectorUpstream } from "./connector-upstream";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";

/**
 * SP-23 connectors. Imports SkillsModule (onConnectorChanged) and
 * IntegrationsModule (LMcpService); SkillsModule's presence comes from the
 * leaf ConnectorPresenceModule, so there is no cycle.
 */
@Module({
  imports: [IntegrationsModule, SkillsModule],
  controllers: [ConnectorsController, ConnectorProxyController],
  providers: [
    ConnectorsService,
    ConnectorAgentService,
    ConnectorCredentials,
    ConnectorCallRecorder,
    ConnectorCallPruneScheduler,
    ConnectorProxyGuard,
    ConnectorProxyRpc,
    { provide: CONNECTOR_UPSTREAM, useClass: HttpConnectorUpstream },
  ],
  exports: [ConnectorsService, CONNECTOR_UPSTREAM],
})
export class ConnectorsModule {}
