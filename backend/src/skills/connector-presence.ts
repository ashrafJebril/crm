import { Injectable } from "@nestjs/common";
import type { ConnectorProvider } from "./skill-catalog";

/** SP-22 port (ruling 2): is the workspace's connector for `provider` connected? */
export interface ConnectorPresence {
  isConnected(workspaceId: string, provider: ConnectorProvider): Promise<boolean>;
}

/** Nest token; SP-23 rebinds it to a presence that reads `Connector.status`. */
export const CONNECTOR_PRESENCE = Symbol("CONNECTOR_PRESENCE");

/** The binding until SP-23 ships: no connector exists, so none is connected. */
@Injectable()
export class NeverConnected implements ConnectorPresence {
  async isConnected(): Promise<boolean> {
    return false;
  }
}
