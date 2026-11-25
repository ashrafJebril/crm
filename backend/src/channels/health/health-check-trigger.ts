import { Injectable, Logger } from "@nestjs/common";

type Handler = (workspaceId: string, channelId: string) => Promise<unknown>;

/**
 * SP-14 (rulings 12 and 15): lets provider webhooks in IntegrationsModule
 * ask for a number health check without importing ChannelsModule (which
 * imports IntegrationsModule; a direct dependency would be a module cycle).
 * Lives in the global ChannelsCoreModule; `ChannelHealthService` binds the
 * handler at construction.
 *
 * `request` never throws and does not wait for the check: a webhook is
 * acknowledged at once, and the check honours its cooldown and caps.
 */
@Injectable()
export class HealthCheckTrigger {
  private readonly log = new Logger(HealthCheckTrigger.name);
  private handler: Handler | null = null;
  /** Checks started and not yet settled (specs await them). */
  private readonly inFlight = new Set<Promise<unknown>>();

  bind(handler: Handler): void {
    this.handler = handler;
  }

  request(workspaceId: string, channelId: string): void {
    if (!this.handler) {
      this.log.debug(`no health checker bound; webhook check of channel ${channelId} dropped`);
      return;
    }
    const p = Promise.resolve()
      .then(() => this.handler?.(workspaceId, channelId))
      .catch((e) => this.log.warn(`webhook health check of channel ${channelId} failed: ${(e as Error)?.name ?? "error"}`));
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Resolves once every requested check has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
}
