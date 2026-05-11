import { Controller, Injectable, Logger, Post } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { EnrichmentService } from "./enrichment.service";
import { GoogleCsePoller } from "./sources/google-cse.poller";
import { MetaIgPoller } from "./sources/meta-ig.poller";
import { Poller, RawMention } from "./sources/poller.types";

@Injectable()
export class MentionsScheduler {
  private readonly logger = new Logger(MentionsScheduler.name);
  private readonly pollers: Poller[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichment: EnrichmentService,
    google: GoogleCsePoller,
    metaIg: MetaIgPoller,
  ) {
    this.pollers = [google, metaIg];
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async cronTick() {
    await this.runOnce();
  }

  async runOnce(): Promise<{ scanned: number; ingested: number }> {
    const keywords = await this.prisma.keyword.findMany({ where: { enabled: true } });
    let scanned = 0;
    let ingested = 0;
    for (const kw of keywords) {
      for (const poller of this.pollers) {
        let raws: RawMention[];
        try {
          raws = await poller.fetchFor(kw);
        } catch (err) {
          this.logger.warn(`Poller ${poller.source} threw: ${(err as Error).message}`);
          continue;
        }
        scanned += raws.length;
        for (const r of raws) {
          const existing = await this.prisma.mention.findUnique({
            where: { source_externalId: { source: r.source, externalId: r.externalId } },
          });
          if (existing) continue;
          const enr = await this.enrichment.enrich(r.body);
          await this.prisma.mention.create({
            data: {
              keywordId: kw.id,
              source: r.source,
              sourceUrl: r.sourceUrl,
              externalId: r.externalId,
              author: r.author,
              authorHandle: r.authorHandle,
              authorReach: r.authorReach,
              body: r.body,
              postedAt: r.postedAt,
              lang: enr.lang,
              dialect: enr.dialect,
              sentiment: enr.sentiment,
              topic: enr.topic,
              raw: JSON.stringify(r.raw),
            },
          });
          ingested += 1;
        }
      }
    }
    this.logger.log(`Poll cycle complete: scanned=${scanned}, ingested=${ingested}`);
    return { scanned, ingested };
  }
}

@Controller("mentions/_admin")
export class MentionsAdminController {
  constructor(private readonly scheduler: MentionsScheduler) {}

  @Post("run")
  run() {
    return this.scheduler.runOnce();
  }
}
