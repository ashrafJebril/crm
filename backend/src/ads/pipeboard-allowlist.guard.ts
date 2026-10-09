import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ADS_PROVIDER, type AdsProviderPort } from './ads-provider.port';
import { crossCheckAllowlist } from './pipeboard-allowlist';

/**
 * Boot-time defense-in-depth for the passthrough gate. Pulls the live tools/list
 * and re-verifies that every allowlisted tool is still marked read-only by
 * Pipeboard. It is NOT the gate — the gate (dispatchTool → pipeboardCall) is
 * fail-closed on its own and does not depend on this running. This only catches
 * the one thing the static list can't: Pipeboard changing a tool's behavior (or
 * us mis-adding one) so a tool we execute ungated has become a write.
 *
 * FATAL (a too-loose disagreement) → throw → refuse to boot. WARN (drift: a
 * vanished or newly-shipped tool) → log only. A boot-time introspection FAILURE
 * (Pipeboard down / no token) is logged, NOT fatal — coupling our API's boot to
 * Pipeboard's uptime would be its own outage, and the runtime gate is unaffected.
 */
@Injectable()
export class PipeboardAllowlistGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(PipeboardAllowlistGuard.name);

  constructor(@Inject(ADS_PROVIDER) private readonly provider: AdsProviderPort) {}

  async onApplicationBootstrap(): Promise<void> {
    let tools;
    try {
      tools = await this.provider.listRawTools();
    } catch (e: any) {
      this.logger.warn(
        `Pipeboard allowlist cross-check SKIPPED — tools/list unreachable at boot (${e?.message ?? e}). ` +
          'Runtime gate is unaffected (fail-closed).',
      );
      return;
    }

    const { fatal, warn } = crossCheckAllowlist(tools);
    for (const w of warn) this.logger.warn(`Pipeboard allowlist drift: ${w}`);
    if (fatal.length) {
      throw new Error(
        'Pipeboard allowlist cross-check FAILED — refusing to boot:\n  - ' + fatal.join('\n  - '),
      );
    }
    this.logger.log(`Pipeboard allowlist verified against ${tools.length} live tools — no violations.`);
  }
}
