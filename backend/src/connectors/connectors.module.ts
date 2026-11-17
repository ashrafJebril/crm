import { Module } from "@nestjs/common";
import { IntegrationsModule } from "../integrations/integrations.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ConnectorAttentionService } from "./connector-attention.service";
import { ConnectorOAuthHttp } from "./connector-oauth-http";
import { ConnectorOAuthService } from "./connector-oauth.service";
import { ConnectorRefreshScheduler } from "./connector-refresh.scheduler";
import { ConnectorStatusService } from "./connector-status.service";
import { ConnectorTokenService } from "./connector-token.service";
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
  imports: [IntegrationsModule, SkillsModule, NotificationsModule],
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
    // Task 2: OAuth, tokens, needs-attention.
    ConnectorStatusService,
    ConnectorAttentionService,
    ConnectorOAuthHttp,
    ConnectorTokenService,
    ConnectorOAuthService,
    ConnectorRefreshScheduler,
  ],
  exports: [ConnectorsService, ConnectorStatusService, ConnectorTokenService, CONNECTOR_UPSTREAM],
})
export class ConnectorsModule {}
