import { HttpException, Injectable } from "@nestjs/common";
import {
  KnowledgeClient,
  type KewyAutonomyMode,
  type KewyKillSwitchResult,
} from "./knowledge.client";
import { tenantIdFor } from "./tenant";

/**
 * The owner-facing view of "is the AI answering my customers?".
 *
 * Same tenant boundary as KnowledgeService: every method takes `workspaceId`
 * FIRST and derives the upstream tenantId from it. Nothing here accepts a
 * tenantId, so no request body can name another salon's bot — which matters
 * more here than for knowledge, because this surface can SILENCE that bot.
 */

/** What the browser is allowed to see. A strict subset of the upstream config:
 *  identity, cost internals and anything secret-shaped stay server-side. */
export interface AiSettingsView {
  /** The single truth the owner cares about: is the agent running at all?
   *  Folds killSwitch in — an operator-set kill switch beats aiEnabled, and
   *  showing "on" while a kill switch holds it off would be a lie. */
  aiEnabled: boolean;
  autonomyMode: KewyAutonomyMode;
  personaName: string;
  locale: string;
  dailyCostCapJod: number | null;
  /** False when this deployment never bought the AI module. */
  configured: boolean;
}

@Injectable()
export class AiSettingsService {
  constructor(private readonly client: KnowledgeClient) {}

  async get(workspaceId: string): Promise<AiSettingsView> {
    if (!this.client.isConfigured()) {
      // Answer the shape the UI expects rather than a 503, so the tab can say
      // "not set up here" instead of rendering a red error on a deployment
      // that legitimately has no AI module.
      return {
        aiEnabled: false,
        autonomyMode: "SHADOW",
        personaName: "",
        locale: "en",
        dailyCostCapJod: null,
        configured: false,
      };
    }

    const cfg = await this.client.getConfig(tenantIdFor(workspaceId));
    return {
      // killSwitch is an operator-level override that forces the agent off, so
      // the effective answer is the AND of the two. The UI shows one switch;
      // it must not read "on" while nothing is actually being answered.
      aiEnabled: cfg.aiEnabled && !cfg.killSwitch,
      autonomyMode: cfg.autonomyMode,
      personaName: cfg.personaName,
      locale: cfg.locale,
      dailyCostCapJod: cfg.dailyCostCapJod,
      configured: true,
    };
  }

  /**
   * The emergency stop.
   *
   * Turning it OFF requires a reason — upstream's zod schema demands one, and
   * the rule is right: an undocumented silence is one nobody dares reverse. We
   * check it HERE too, so the owner gets a sentence written for them instead of
   * a passed-through upstream validation string.
   */
  async setEnabled(
    workspaceId: string,
    input: { enabled: boolean; reason?: string },
  ): Promise<KewyKillSwitchResult> {
    const reason = input.reason?.trim();
    if (!input.enabled && !reason) {
      throw new HttpException(
        {
          code: "REASON_REQUIRED",
          message:
            "Say why you're turning the assistant off — it's the record of why it was silenced, so whoever finds it off later knows whether to turn it back on.",
        },
        400,
      );
    }

    return this.client.setKillSwitch(tenantIdFor(workspaceId), {
      aiEnabled: input.enabled,
      // Omitted entirely when enabling: upstream only stores a reason for a
      // disable, and sending "" would fail its 1..500 length rule.
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Change how replies are delivered — NOT whether the agent runs.
   *
   * Only autonomyMode is writable in this pass. Everything else in the upstream
   * config (persona, locale, cost cap) has consequences this UI does not yet
   * explain, and a settings screen that changes something it never described is
   * how an owner loses trust in the whole tab.
   */
  async setAutonomyMode(
    workspaceId: string,
    autonomyMode: KewyAutonomyMode,
  ): Promise<AiSettingsView> {
    await this.client.patchConfig(tenantIdFor(workspaceId), { autonomyMode });
    // Re-read rather than trusting the PATCH response: the owner is about to
    // act on what this screen claims, so it should reflect stored state.
    return this.get(workspaceId);
  }
}
