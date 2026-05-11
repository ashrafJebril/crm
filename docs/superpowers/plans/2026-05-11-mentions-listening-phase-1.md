# Mentions / Social Listening — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the thin listening layer that turns brand mentions from Google news/blogs and Instagram hashtags into actionable items in tkana — surfaced as a new Mentions screen with sentiment + language tagging, and a one-click "open ticket" action that feeds the existing Pipeline.

**Architecture:**
- New `Mention` and `Keyword` Prisma models (single-tenant, since the codebase has no workspace concept yet).
- A NestJS `mentions` module with two pollers (Google Custom Search, Meta IG hashtag) feeding a shared enrichment pipeline that calls Claude Haiku 4.5 for sentiment + language + Arabic-dialect classification.
- Frontend: a new `Mentions` screen (filter + list + detail, modeled on Inbox patterns) plus a Settings-area Keywords page. The "unified into Inbox" refactor is deliberately deferred to a Phase 2 plan to avoid churning the already-large [Inbox.tsx](src/screens/Inbox.tsx) in Phase 1.
- Agents module is intentionally untouched per scope decision.

**Tech Stack:** NestJS 10, Prisma 5 (SQLite dev), `@nestjs/schedule`, `@anthropic-ai/sdk` (new), React 18 + Vite + Tailwind v4. Verification is manual via curl + Prisma Studio + browser dev server — the codebase has no test framework today and we won't add one in this plan.

**Scope explicitly excluded (deferred to later plans):**
- X/Twitter ingestion (cost-gated; revisit when a customer demands it)
- AI Agents changes
- Spike alerts / WhatsApp digest (Phase 2)
- Influencer reach scoring (Phase 3)
- Review-site monitoring (Phase 3)
- Custom dashboards / scheduled reports

---

## File Structure

**Backend — created:**
- `backend/src/mentions/mentions.module.ts` — module wiring
- `backend/src/mentions/mentions.service.ts` — list/get/update mentions
- `backend/src/mentions/mentions.controller.ts` — `/api/mentions/*` REST
- `backend/src/mentions/mentions.dto.ts`
- `backend/src/mentions/keywords.service.ts` — CRUD for tracked keywords
- `backend/src/mentions/keywords.controller.ts` — `/api/keywords/*`
- `backend/src/mentions/keywords.dto.ts`
- `backend/src/mentions/enrichment.service.ts` — Claude Haiku call: lang+sentiment+dialect+topic
- `backend/src/mentions/sources/poller.types.ts` — shared `Poller` interface and `RawMention` type
- `backend/src/mentions/sources/google-cse.poller.ts` — Google Custom Search ingestion
- `backend/src/mentions/sources/meta-ig.poller.ts` — Instagram hashtag ingestion (reuses existing `Integration` rows)
- `backend/src/mentions/mentions.scheduler.ts` — `@nestjs/schedule` cron, calls each poller every 15 min, plus manual-trigger endpoint
- `backend/src/mentions/open-ticket.service.ts` — creates a Contact (phone null) + Ticket from a mention

**Backend — modified:**
- `backend/prisma/schema.prisma` — add `Mention`, `Keyword`; change `Contact.phone` to optional
- `backend/src/app.module.ts` — register `ScheduleModule.forRoot()` and `MentionsModule`
- `backend/src/contacts/contacts.service.ts` — handle null phone in `shape()`
- `backend/src/contacts/contacts.dto.ts` — make `phone` optional in `CreateContactDto`
- `backend/package.json` — add `@anthropic-ai/sdk`, `@nestjs/schedule`
- `backend/.env.example` — add `ANTHROPIC_API_KEY`, `GOOGLE_CSE_KEY`, `GOOGLE_CSE_CX`

**Frontend — created:**
- `src/screens/Mentions.tsx` — list+detail screen modeled on [Inbox.tsx](src/screens/Inbox.tsx)
- `src/screens/Keywords.tsx` — keyword management page
- `src/data/mentions-extras.ts` — demo fallback data (used when API is empty)

**Frontend — modified:**
- `src/lib/types.ts` — add `Mention`, `Keyword`, related enum types; add `"mentions" | "keywords"` to `RouteId`
- `src/shell/nav.ts` — add Mentions and Keywords nav entries
- `src/router.tsx` — wire new routes
- `src/icons/index.tsx` — add an `IconRadar` icon for the Mentions nav

---

## Task 1: Schema — add `Mention`, `Keyword`, make `Contact.phone` optional

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Edit the Contact model — make phone optional**

In `backend/prisma/schema.prisma`, change:

```prisma
model Contact {
  id        String   @id @default(cuid())
  name      String
  phone     String
```

to:

```prisma
model Contact {
  id        String   @id @default(cuid())
  name      String
  phone     String?
```

Leave the rest of the Contact model untouched.

- [ ] **Step 2: Append the Keyword and Mention models**

Append at the bottom of `backend/prisma/schema.prisma`:

```prisma
// ─── Social listening ──────────────────────────────────────────────────────

model Keyword {
  id        String   @id @default(cuid())
  value     String   @unique
  kind      String   // "brand" | "hashtag" | "handle" | "competitor"
  enabled   Boolean  @default(true)
  notes     String?

  mentions  Mention[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Mention {
  id           String   @id @default(cuid())
  keywordId    String
  source       String   // "google" | "ig-hashtag" | "fb-page" | "news"
  sourceUrl    String?
  externalId   String   // dedup key within a source
  author       String
  authorHandle String?
  authorReach  Int?
  body         String
  lang         String?  // "en" | "ar" | "mixed"
  dialect      String?  // "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi"
  sentiment    Float?   // -1..+1
  topic        String?
  postedAt     DateTime?
  ingestedAt   DateTime @default(now())
  status       String   @default("new") // "new" | "triaged" | "engaged" | "dismissed"
  raw          String?  // JSON blob from source

  keyword Keyword @relation(fields: [keywordId], references: [id], onDelete: Cascade)

  @@unique([source, externalId])
  @@index([keywordId])
  @@index([status])
  @@index([ingestedAt])
}
```

- [ ] **Step 3: Push the schema and regenerate client**

Run from `backend/`:

```powershell
npm run prisma:push; if ($?) { npm run prisma:generate }
```

Expected: "🚀  Your database is now in sync with your Prisma schema." followed by Prisma Client generation success.

- [ ] **Step 4: Verify with Prisma Studio**

Run from `backend/`:

```powershell
npm run prisma:studio
```

Open `http://localhost:5555` in the browser. Confirm `Keyword` and `Mention` tables exist with the columns above and that `Contact.phone` shows as nullable. Close Studio.

- [ ] **Step 5: Commit**

```powershell
git add backend/prisma/schema.prisma
git commit -m "feat(db): add Keyword and Mention models; make Contact.phone optional"
```

---

## Task 2: Make `Contact` service tolerate nullable phone

**Files:**
- Modify: `backend/src/contacts/contacts.service.ts`
- Modify: `backend/src/contacts/contacts.dto.ts`

- [ ] **Step 1: Update the contact row shape**

In `backend/src/contacts/contacts.service.ts`, change the `ContactRow` interface:

```ts
interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  industry: string;
  lifecycle: string;
  source: string;
  value: string | null;
  lastSeen: string;
  tags: string;
  convs: number;
}
```

And change `shape()` to coerce null phone to an empty string for the frontend:

```ts
const shape = (c: ContactRow) => ({
  id: c.id,
  name: c.name,
  phone: c.phone ?? "",
  industry: c.industry,
  lifecycle: c.lifecycle,
  source: c.source,
  value: c.value ?? "—",
  lastSeen: c.lastSeen,
  tags: JSON.parse(c.tags) as string[],
  convs: c.convs,
});
```

And in `create()`, change the `phone` line to allow undefined:

```ts
phone: dto.phone ?? null,
```

- [ ] **Step 2: Make phone optional in DTOs**

In `backend/src/contacts/contacts.dto.ts`, find the `CreateContactDto` and change the `phone` decorator block. Open the file and locate the existing `phone` field (it will be marked `@IsString()`). Change to:

```ts
@IsString()
@IsOptional()
phone?: string;
```

Import `IsOptional` from `class-validator` at the top of the file if it's not already imported.

- [ ] **Step 3: Build the backend to confirm no type errors**

Run from `backend/`:

```powershell
npm run build
```

Expected: clean build, no TypeScript errors.

- [ ] **Step 4: Smoke-test with curl**

Start the backend (`npm run dev` in `backend/`). In another shell:

```powershell
$body = '{ "name": "Smoke Test Mention Author", "industry": "media", "lifecycle": "lead", "source": "google" }'
Invoke-RestMethod -Uri "http://localhost:3001/api/contacts" -Method Post -ContentType "application/json" -Body $body
```

Expected: a `Contact` JSON response with `"phone": ""`. (You may need an auth header if the contacts route is guarded — if it returns 401, temporarily annotate the controller method with `@Public()` for this smoke test, then revert.)

Clean up the test contact via Prisma Studio or:

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/contacts/<id-from-response>" -Method Delete
```

- [ ] **Step 5: Commit**

```powershell
git add backend/src/contacts/contacts.service.ts backend/src/contacts/contacts.dto.ts
git commit -m "feat(contacts): allow nullable phone for mention-sourced contacts"
```

---

## Task 3: Install dependencies and env scaffolding

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/.env.example` (create if missing)

- [ ] **Step 1: Install runtime dependencies**

Run from `backend/`:

```powershell
npm install @anthropic-ai/sdk @nestjs/schedule
```

Expected: successful install. `@anthropic-ai/sdk` will be the latest (post-1.0). `@nestjs/schedule` will be ^4.x.

- [ ] **Step 2: Add env example entries**

Open or create `backend/.env.example` and append:

```
# Listening / mentions
ANTHROPIC_API_KEY=
GOOGLE_CSE_KEY=
GOOGLE_CSE_CX=
META_GRAPH_VERSION=v21.0
```

Also append the same keys (with real values from the user) to `backend/.env`. The user is responsible for filling in the actual keys; do not commit `.env`.

- [ ] **Step 3: Register `ScheduleModule` globally**

Open `backend/src/app.module.ts`. At the top of the imports, add:

```ts
import { ScheduleModule } from "@nestjs/schedule";
```

Find the `imports: [...]` array of the `@Module` decorator and add `ScheduleModule.forRoot()` as the first entry (before all other modules).

- [ ] **Step 4: Build to confirm**

```powershell
npm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```powershell
git add backend/package.json backend/package-lock.json backend/.env.example backend/src/app.module.ts
git commit -m "chore(deps): add @anthropic-ai/sdk and @nestjs/schedule"
```

---

## Task 4: Enrichment service — Claude Haiku 4.5 for lang + sentiment + dialect + topic

**Files:**
- Create: `backend/src/mentions/enrichment.service.ts`

- [ ] **Step 1: Create the enrichment service**

Create `backend/src/mentions/enrichment.service.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

export interface Enrichment {
  lang: "en" | "ar" | "mixed";
  dialect: "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi" | null;
  sentiment: number; // -1..+1
  topic: string | null;
}

const SYSTEM_PROMPT = `You classify short social/news snippets about a brand.
Return strict JSON: { "lang": "en" | "ar" | "mixed",
                       "dialect": "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi" | null,
                       "sentiment": number between -1 and 1,
                       "topic": short 2-4 word topic label or null }.
Rules:
- dialect MUST be null when lang is "en".
- dialect MUST NOT be null when lang is "ar".
- sentiment: -1 very negative, 0 neutral, +1 very positive.
- topic: lowercase, no punctuation, e.g. "delivery delay", "product quality".
- Output ONLY the JSON object, no prose.`;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);
  private readonly client: Anthropic | null;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) this.logger.warn("ANTHROPIC_API_KEY not set — enrichment will fall back to neutral defaults");
  }

  async enrich(body: string): Promise<Enrichment> {
    if (!this.client) return { lang: "en", dialect: null, sentiment: 0, topic: null };

    try {
      const resp = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: body.slice(0, 2000) }],
      });

      const first = resp.content[0];
      if (!first || first.type !== "text") return this.fallback();
      const parsed = JSON.parse(this.stripFence(first.text)) as Enrichment;
      return this.coerce(parsed);
    } catch (err) {
      this.logger.warn(`Enrichment failed: ${(err as Error).message}`);
      return this.fallback();
    }
  }

  private stripFence(s: string): string {
    return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  private fallback(): Enrichment {
    return { lang: "en", dialect: null, sentiment: 0, topic: null };
  }

  private coerce(e: Partial<Enrichment>): Enrichment {
    const lang = e.lang === "ar" || e.lang === "mixed" || e.lang === "en" ? e.lang : "en";
    const dialect =
      lang === "en"
        ? null
        : ["msa", "gulf", "egyptian", "levantine", "maghrebi"].includes(e.dialect as string)
          ? (e.dialect as Enrichment["dialect"])
          : "msa";
    const rawSent = typeof e.sentiment === "number" ? e.sentiment : 0;
    const sentiment = Math.max(-1, Math.min(1, rawSent));
    const topic = typeof e.topic === "string" && e.topic.length > 0 && e.topic.length < 40 ? e.topic : null;
    return { lang, dialect, sentiment, topic };
  }
}
```

- [ ] **Step 2: Smoke test the service with a tiny script**

Create `backend/scripts/smoke-enrichment.ts`:

```ts
import "reflect-metadata";
import { EnrichmentService } from "../src/mentions/enrichment.service";

async function main() {
  const svc = new EnrichmentService();
  const cases = [
    "Just got my Samemha shirt — quality is amazing! Will order more.",
    "ما وصلني الطلب من سَمِّمها لين الحين، تأخروا أسبوع كامل!",
    "بصراحة الطباعة حلوة بس التوصيل بطيء شوي",
  ];
  for (const c of cases) {
    console.log("\n>>>", c);
    console.log(await svc.enrich(c));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Run the smoke test**

From `backend/`:

```powershell
npx tsx scripts/smoke-enrichment.ts
```

Expected: three JSON outputs. The first should be `lang: "en"`, positive sentiment, dialect null. The second should be `lang: "ar"`, negative sentiment, dialect "gulf" or "levantine". The third should be `lang: "ar"`, mildly mixed sentiment (slightly positive or neutral). If `ANTHROPIC_API_KEY` is not set, all three return the neutral fallback — that confirms the fallback works, but set the key before continuing.

- [ ] **Step 4: Commit**

```powershell
git add backend/src/mentions/enrichment.service.ts backend/scripts/smoke-enrichment.ts
git commit -m "feat(mentions): add Claude Haiku enrichment service for lang/sentiment/dialect"
```

---

## Task 5: Keywords CRUD module

**Files:**
- Create: `backend/src/mentions/keywords.dto.ts`
- Create: `backend/src/mentions/keywords.service.ts`
- Create: `backend/src/mentions/keywords.controller.ts`

- [ ] **Step 1: Create the DTO file**

Create `backend/src/mentions/keywords.dto.ts`:

```ts
import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";

export const KEYWORD_KINDS = ["brand", "hashtag", "handle", "competitor"] as const;
export type KeywordKind = (typeof KEYWORD_KINDS)[number];

export class CreateKeywordDto {
  @IsString()
  @MinLength(1)
  value!: string;

  @IsIn(KEYWORD_KINDS as unknown as string[])
  kind!: KeywordKind;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateKeywordDto {
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsString()
  @IsOptional()
  notes?: string;
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/mentions/keywords.service.ts`:

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateKeywordDto, UpdateKeywordDto } from "./keywords.dto";

@Injectable()
export class KeywordsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.keyword.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const row = await this.prisma.keyword.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Keyword not found");
    return row;
  }

  create(dto: CreateKeywordDto) {
    return this.prisma.keyword.create({
      data: {
        value: dto.value,
        kind: dto.kind,
        enabled: dto.enabled ?? true,
        notes: dto.notes ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateKeywordDto) {
    await this.get(id);
    return this.prisma.keyword.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.keyword.delete({ where: { id } });
    return { ok: true };
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/mentions/keywords.controller.ts`:

```ts
import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { KeywordsService } from "./keywords.service";
import { CreateKeywordDto, UpdateKeywordDto } from "./keywords.dto";

@Controller("keywords")
export class KeywordsController {
  constructor(private readonly svc: KeywordsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateKeywordDto) {
    return this.svc.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateKeywordDto) {
    return this.svc.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }
}
```

- [ ] **Step 4: Commit (module wiring comes in Task 10)**

```powershell
git add backend/src/mentions/keywords.dto.ts backend/src/mentions/keywords.service.ts backend/src/mentions/keywords.controller.ts
git commit -m "feat(mentions): add keywords CRUD"
```

---

## Task 6: Mentions list/get/update service + controller

**Files:**
- Create: `backend/src/mentions/mentions.dto.ts`
- Create: `backend/src/mentions/mentions.service.ts`
- Create: `backend/src/mentions/mentions.controller.ts`

- [ ] **Step 1: Create the DTO file**

Create `backend/src/mentions/mentions.dto.ts`:

```ts
import { IsIn, IsOptional, IsString } from "class-validator";

export const MENTION_STATUSES = ["new", "triaged", "engaged", "dismissed"] as const;
export type MentionStatus = (typeof MENTION_STATUSES)[number];

export class UpdateMentionDto {
  @IsIn(MENTION_STATUSES as unknown as string[])
  @IsOptional()
  status?: MentionStatus;
}

export class ListMentionsQuery {
  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  keywordId?: string;

  @IsString()
  @IsOptional()
  source?: string;
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/mentions/mentions.service.ts`:

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";

@Injectable()
export class MentionsService {
  constructor(private readonly prisma: PrismaService) {}

  list(q: ListMentionsQuery) {
    return this.prisma.mention.findMany({
      where: {
        status: q.status,
        keywordId: q.keywordId,
        source: q.source,
      },
      orderBy: { ingestedAt: "desc" },
      take: 200,
      include: { keyword: true },
    });
  }

  async get(id: string) {
    const row = await this.prisma.mention.findUnique({
      where: { id },
      include: { keyword: true },
    });
    if (!row) throw new NotFoundException("Mention not found");
    return row;
  }

  async update(id: string, dto: UpdateMentionDto) {
    await this.get(id);
    return this.prisma.mention.update({ where: { id }, data: dto });
  }
}
```

- [ ] **Step 3: Create the controller**

Create `backend/src/mentions/mentions.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { MentionsService } from "./mentions.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";

@Controller("mentions")
export class MentionsController {
  constructor(private readonly svc: MentionsService) {}

  @Get()
  list(@Query() q: ListMentionsQuery) {
    return this.svc.list(q);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateMentionDto) {
    return this.svc.update(id, dto);
  }
}
```

- [ ] **Step 4: Commit**

```powershell
git add backend/src/mentions/mentions.dto.ts backend/src/mentions/mentions.service.ts backend/src/mentions/mentions.controller.ts
git commit -m "feat(mentions): list/get/update mentions"
```

---

## Task 7: Pollers — shared types + Google Custom Search + Meta IG hashtag

**Files:**
- Create: `backend/src/mentions/sources/poller.types.ts`
- Create: `backend/src/mentions/sources/google-cse.poller.ts`
- Create: `backend/src/mentions/sources/meta-ig.poller.ts`

- [ ] **Step 1: Define the shared poller contract**

Create `backend/src/mentions/sources/poller.types.ts`:

```ts
export interface RawMention {
  source: string;        // "google" | "ig-hashtag" | "fb-page"
  externalId: string;    // unique within source
  sourceUrl: string | null;
  author: string;
  authorHandle: string | null;
  authorReach: number | null;
  body: string;
  postedAt: Date | null;
  raw: unknown;
}

export interface Poller {
  readonly source: string;
  /** Fetch new mentions for one keyword. Returns RawMentions; dedup happens upstream. */
  fetchFor(keyword: { id: string; value: string; kind: string }): Promise<RawMention[]>;
}
```

- [ ] **Step 2: Implement the Google CSE poller**

Create `backend/src/mentions/sources/google-cse.poller.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { Poller, RawMention } from "./poller.types";

interface CseItem {
  link?: string;
  title?: string;
  snippet?: string;
  displayLink?: string;
  cacheId?: string;
}

interface CseResponse {
  items?: CseItem[];
}

@Injectable()
export class GoogleCsePoller implements Poller {
  readonly source = "google";
  private readonly logger = new Logger(GoogleCsePoller.name);

  async fetchFor(keyword: { id: string; value: string; kind: string }): Promise<RawMention[]> {
    const key = process.env.GOOGLE_CSE_KEY;
    const cx = process.env.GOOGLE_CSE_CX;
    if (!key || !cx) {
      this.logger.warn("GOOGLE_CSE_KEY or GOOGLE_CSE_CX not set — skipping Google poller");
      return [];
    }
    if (keyword.kind === "hashtag") return []; // hashtags belong to IG poller

    const query = encodeURIComponent(`"${keyword.value}"`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${query}&num=10&dateRestrict=d7`;
    let body: CseResponse;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        this.logger.warn(`Google CSE returned ${resp.status} for "${keyword.value}"`);
        return [];
      }
      body = (await resp.json()) as CseResponse;
    } catch (err) {
      this.logger.warn(`Google CSE fetch failed: ${(err as Error).message}`);
      return [];
    }
    return (body.items ?? []).flatMap<RawMention>((it) => {
      if (!it.link) return [];
      return [
        {
          source: this.source,
          externalId: it.cacheId ?? it.link,
          sourceUrl: it.link,
          author: it.displayLink ?? "web",
          authorHandle: null,
          authorReach: null,
          body: `${it.title ?? ""} — ${it.snippet ?? ""}`.trim(),
          postedAt: null,
          raw: it,
        },
      ];
    });
  }
}
```

- [ ] **Step 3: Implement the Meta IG hashtag poller**

Create `backend/src/mentions/sources/meta-ig.poller.ts`:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Poller, RawMention } from "./poller.types";

interface IgMedia {
  id: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  username?: string;
  like_count?: number;
  comments_count?: number;
}

interface IgHashtagSearchResp {
  data?: Array<{ id: string }>;
}

interface IgMediaListResp {
  data?: IgMedia[];
}

@Injectable()
export class MetaIgPoller implements Poller {
  readonly source = "ig-hashtag";
  private readonly logger = new Logger(MetaIgPoller.name);

  constructor(private readonly prisma: PrismaService) {}

  async fetchFor(keyword: { id: string; value: string; kind: string }): Promise<RawMention[]> {
    if (keyword.kind !== "hashtag") return [];

    const integration = await this.prisma.integration.findUnique({
      where: { platform: "instagram" },
    });
    if (!integration?.accessToken || !integration.pageId) {
      this.logger.warn("Instagram integration not connected — skipping IG poller");
      return [];
    }

    const v = process.env.META_GRAPH_VERSION ?? "v21.0";
    const igUserId = integration.pageId;
    const token = integration.accessToken;
    const tag = keyword.value.replace(/^#/, "");

    // 1) Resolve hashtag id
    const searchUrl = `https://graph.facebook.com/${v}/ig_hashtag_search?user_id=${igUserId}&q=${encodeURIComponent(tag)}&access_token=${token}`;
    let hashtagId: string | undefined;
    try {
      const resp = await fetch(searchUrl);
      if (!resp.ok) {
        this.logger.warn(`IG hashtag search ${resp.status} for #${tag}`);
        return [];
      }
      const body = (await resp.json()) as IgHashtagSearchResp;
      hashtagId = body.data?.[0]?.id;
    } catch (err) {
      this.logger.warn(`IG hashtag search failed: ${(err as Error).message}`);
      return [];
    }
    if (!hashtagId) return [];

    // 2) Pull recent media for that hashtag
    const fields = "id,caption,permalink,timestamp,username,like_count,comments_count";
    const mediaUrl = `https://graph.facebook.com/${v}/${hashtagId}/recent_media?user_id=${igUserId}&fields=${fields}&access_token=${token}`;
    try {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) {
        this.logger.warn(`IG recent_media ${resp.status} for #${tag}`);
        return [];
      }
      const body = (await resp.json()) as IgMediaListResp;
      return (body.data ?? []).flatMap<RawMention>((m) => {
        if (!m.id) return [];
        return [
          {
            source: this.source,
            externalId: m.id,
            sourceUrl: m.permalink ?? null,
            author: m.username ?? "instagram_user",
            authorHandle: m.username ? `@${m.username}` : null,
            authorReach: m.like_count ?? null,
            body: m.caption ?? "",
            postedAt: m.timestamp ? new Date(m.timestamp) : null,
            raw: m,
          },
        ];
      });
    } catch (err) {
      this.logger.warn(`IG recent_media failed: ${(err as Error).message}`);
      return [];
    }
  }
}
```

- [ ] **Step 4: Commit**

```powershell
git add backend/src/mentions/sources
git commit -m "feat(mentions): add Google CSE and Meta IG hashtag pollers"
```

---

## Task 8: Scheduler — cron + manual trigger

**Files:**
- Create: `backend/src/mentions/mentions.scheduler.ts`

- [ ] **Step 1: Create the scheduler**

Create `backend/src/mentions/mentions.scheduler.ts`:

```ts
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
```

- [ ] **Step 2: Commit**

```powershell
git add backend/src/mentions/mentions.scheduler.ts
git commit -m "feat(mentions): cron scheduler + manual trigger endpoint"
```

---

## Task 9: "Open ticket from mention" service

**Files:**
- Create: `backend/src/mentions/open-ticket.service.ts`
- Modify: `backend/src/mentions/mentions.controller.ts`

- [ ] **Step 1: Create the open-ticket service**

Create `backend/src/mentions/open-ticket.service.ts`:

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OpenTicketService {
  constructor(private readonly prisma: PrismaService) {}

  async fromMention(mentionId: string) {
    const mention = await this.prisma.mention.findUnique({ where: { id: mentionId } });
    if (!mention) throw new NotFoundException("Mention not found");

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { isDefault: true },
      include: { stages: { orderBy: { order: "asc" } } },
    });
    if (!pipeline || pipeline.stages.length === 0) {
      throw new NotFoundException("No default pipeline configured");
    }
    const firstStage = pipeline.stages[0];

    const contact = await this.prisma.contact.create({
      data: {
        name: mention.author,
        phone: null,
        industry: "social",
        lifecycle: "lead",
        source: mention.source,
        lastSeen: "just now",
        tags: JSON.stringify(["mention", mention.source]),
      },
    });

    const lastTicket = await this.prisma.ticket.findFirst({
      where: { pipelineId: pipeline.id },
      orderBy: { number: "desc" },
    });
    const number = (lastTicket?.number ?? 0) + 1;

    const ticket = await this.prisma.ticket.create({
      data: {
        number,
        pipelineId: pipeline.id,
        stageId: firstStage.id,
        contactId: contact.id,
        title: mention.body.slice(0, 80),
        description: mention.sourceUrl ?? null,
      },
    });

    await this.prisma.mention.update({
      where: { id: mentionId },
      data: { status: "triaged" },
    });

    return { ticketId: ticket.id, contactId: contact.id };
  }
}
```

- [ ] **Step 2: Add the controller endpoint**

In `backend/src/mentions/mentions.controller.ts`, add `OpenTicketService` to the constructor and add a new endpoint. Final file:

```ts
import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { MentionsService } from "./mentions.service";
import { OpenTicketService } from "./open-ticket.service";
import { ListMentionsQuery, UpdateMentionDto } from "./mentions.dto";

@Controller("mentions")
export class MentionsController {
  constructor(
    private readonly svc: MentionsService,
    private readonly tickets: OpenTicketService,
  ) {}

  @Get()
  list(@Query() q: ListMentionsQuery) {
    return this.svc.list(q);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateMentionDto) {
    return this.svc.update(id, dto);
  }

  @Post(":id/open-ticket")
  openTicket(@Param("id") id: string) {
    return this.tickets.fromMention(id);
  }
}
```

- [ ] **Step 3: Commit**

```powershell
git add backend/src/mentions/open-ticket.service.ts backend/src/mentions/mentions.controller.ts
git commit -m "feat(mentions): one-click open-ticket-from-mention"
```

---

## Task 10: Wire `MentionsModule` and verify end-to-end

**Files:**
- Create: `backend/src/mentions/mentions.module.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Create the module**

Create `backend/src/mentions/mentions.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MentionsService } from "./mentions.service";
import { MentionsController } from "./mentions.controller";
import { KeywordsService } from "./keywords.service";
import { KeywordsController } from "./keywords.controller";
import { EnrichmentService } from "./enrichment.service";
import { GoogleCsePoller } from "./sources/google-cse.poller";
import { MetaIgPoller } from "./sources/meta-ig.poller";
import { MentionsScheduler, MentionsAdminController } from "./mentions.scheduler";
import { OpenTicketService } from "./open-ticket.service";

@Module({
  imports: [PrismaModule],
  controllers: [MentionsController, KeywordsController, MentionsAdminController],
  providers: [
    MentionsService,
    KeywordsService,
    EnrichmentService,
    GoogleCsePoller,
    MetaIgPoller,
    MentionsScheduler,
    OpenTicketService,
  ],
})
export class MentionsModule {}
```

- [ ] **Step 2: Register in `app.module.ts`**

In `backend/src/app.module.ts`, add the import:

```ts
import { MentionsModule } from "./mentions/mentions.module";
```

Add `MentionsModule` to the `imports` array.

- [ ] **Step 3: Build and start the backend**

```powershell
npm run build
npm run dev
```

Expected: backend starts on port 3001 with no errors. Look in the log for "Nest application successfully started" and the Cron registration.

- [ ] **Step 4: End-to-end smoke via curl**

In a separate shell:

```powershell
# 1) Add a keyword
$kw = '{ "value": "samemha", "kind": "brand" }'
$keyword = Invoke-RestMethod -Uri "http://localhost:3001/api/keywords" -Method Post -ContentType "application/json" -Body $kw
$keyword

# 2) Trigger an immediate poll
Invoke-RestMethod -Uri "http://localhost:3001/api/mentions/_admin/run" -Method Post

# 3) List mentions
Invoke-RestMethod -Uri "http://localhost:3001/api/mentions" -Method Get
```

Expected: the keyword is created; the admin run returns `{ scanned: N, ingested: M }` with M ≥ 0; the mentions list returns an array. If `GOOGLE_CSE_KEY` is set, you should see at least one mention from a public web result. If not, the list will be empty but no errors.

- [ ] **Step 5: Test the open-ticket flow**

If the previous step produced at least one mention:

```powershell
# Pick the first mention id
$mention = (Invoke-RestMethod -Uri "http://localhost:3001/api/mentions" -Method Get)[0]
Invoke-RestMethod -Uri "http://localhost:3001/api/mentions/$($mention.id)/open-ticket" -Method Post
```

Expected: returns `{ ticketId, contactId }`. Verify in Prisma Studio that a new `Contact` (with `phone = null`) and a new `Ticket` exist, and that the `Mention.status` changed to `"triaged"`.

- [ ] **Step 6: Commit**

```powershell
git add backend/src/mentions/mentions.module.ts backend/src/app.module.ts
git commit -m "feat(mentions): wire MentionsModule into app"
```

---

## Task 11: Frontend types and API client

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/api/client.ts` (if it has typed helpers — otherwise no-op)

- [ ] **Step 1: Add types to `src/lib/types.ts`**

Append to `src/lib/types.ts`:

```ts
// ─── Social listening: keywords & mentions ────────────────────────────────

export type KeywordKind = "brand" | "hashtag" | "handle" | "competitor";

export interface Keyword {
  id: string;
  value: string;
  kind: KeywordKind;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MentionSource = "google" | "ig-hashtag" | "fb-page" | "news";
export type MentionStatus = "new" | "triaged" | "engaged" | "dismissed";
export type MentionLang = "en" | "ar" | "mixed";
export type MentionDialect = "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi";

export interface Mention {
  id: string;
  keywordId: string;
  source: MentionSource;
  sourceUrl: string | null;
  externalId: string;
  author: string;
  authorHandle: string | null;
  authorReach: number | null;
  body: string;
  lang: MentionLang | null;
  dialect: MentionDialect | null;
  sentiment: number | null;
  topic: string | null;
  postedAt: string | null;
  ingestedAt: string;
  status: MentionStatus;
  keyword?: Keyword;
}
```

Also extend `RouteId`:

```ts
export type RouteId =
  | "dashboard"
  | "inbox"
  | "calendar"
  | "social"
  | "mentions"
  | "keywords"
  | "pipeline"
  | "agents"
  | "campaigns"
  | "contacts"
  | "automations"
  | "analytics"
  | "templates"
  | "team"
  | "billing"
  | "settings";
```

- [ ] **Step 2: Frontend type-check**

From the repo root:

```powershell
npm run typecheck
```

Expected: the typecheck will fail until Task 12 wires the new routes — that's OK; the error should be specifically about the new `RouteId` values not being handled in `TITLES`, `NAV`, or `router.tsx`. If any *other* error appears, fix it before moving on.

- [ ] **Step 3: Commit**

```powershell
git add src/lib/types.ts
git commit -m "feat(types): add Mention, Keyword, mentions/keywords routes"
```

---

## Task 12: Nav + routing wiring

**Files:**
- Modify: `src/shell/nav.ts`
- Modify: `src/router.tsx`
- Modify: `src/icons/index.tsx`

- [ ] **Step 1: Add the IconRadar icon**

In `src/icons/index.tsx`, add a new icon export. Find the file structure (it exports `Icon*` components). Append:

```tsx
export function IconRadar({ w = 14 }: { w?: number }) {
  return (
    <svg width={w} height={w} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 3 L12 12 L19 8" />
    </svg>
  );
}
```

(If `IconRadar` already exists, skip this step. If the file uses a different icon style — e.g., filled glyphs — match that style.)

- [ ] **Step 2: Add nav entries**

In `src/shell/nav.ts`, import `IconRadar`:

```ts
import {
  IconHome, IconInbox, IconBot, IconCampaign, IconUsers, IconFlow,
  IconChart, IconTemplate, IconTeam, IconBilling, IconCog, IconCal, IconGlobe,
  IconLayers, IconRadar,
} from "@/icons";
```

Insert a new nav entry after `social` and before `agents`:

```ts
{ id: "mentions",    label: "Mentions",    ar: "الإشارات",       Icon: IconRadar, ai: true },
```

In the "Manage" section, after `templates`, insert:

```ts
{ id: "keywords",    label: "Keywords",    ar: "الكلمات المتابَعة", Icon: IconRadar },
```

Add `mentions` and `keywords` entries to `TITLES`:

```ts
mentions:    { en: "Mentions",        ar: "الإشارات والمتابعة" },
keywords:    { en: "Tracked keywords", ar: "الكلمات المتابَعة" },
```

- [ ] **Step 3: Wire `src/router.tsx`**

Open `src/router.tsx`. Find the route mapping (a switch or lookup keyed by `RouteId`). Add lazy imports for `Mentions` and `Keywords` matching the existing import pattern. For example, if other screens use `lazy(() => import("@/screens/Mentions"))`, do the same. Wire both routes into the dispatcher.

Concretely, if the file looks like:

```tsx
const screens: Record<RouteId, ComponentType> = {
  dashboard: lazy(() => import("@/screens/Dashboard")),
  inbox:     lazy(() => import("@/screens/Inbox")),
  // ...
};
```

then add:

```tsx
mentions:  lazy(() => import("@/screens/Mentions")),
keywords:  lazy(() => import("@/screens/Keywords")),
```

(If the routing pattern differs, mirror the existing pattern exactly.)

- [ ] **Step 4: Typecheck — should still fail because screens don't exist**

```powershell
npm run typecheck
```

Expected: error specifically that `@/screens/Mentions` and `@/screens/Keywords` modules cannot be found. Any other error must be fixed before moving on.

- [ ] **Step 5: Commit**

```powershell
git add src/shell/nav.ts src/router.tsx src/icons/index.tsx
git commit -m "feat(nav): add Mentions and Keywords routes"
```

---

## Task 13: Mentions screen — list + filter + detail panel

**Files:**
- Create: `src/screens/Mentions.tsx`
- Create: `src/data/mentions-extras.ts`

- [ ] **Step 1: Create a tiny demo fallback dataset**

Create `src/data/mentions-extras.ts`:

```ts
import type { Mention } from "@/lib/types";

export const DEMO_MENTIONS: Mention[] = [
  {
    id: "demo-1",
    keywordId: "demo-kw",
    source: "google",
    sourceUrl: "https://example.com/post",
    externalId: "demo-1",
    author: "blog.example.com",
    authorHandle: null,
    authorReach: null,
    body: "Just got a Samemha shirt — embroidery quality is genuinely impressive for the price.",
    lang: "en",
    dialect: null,
    sentiment: 0.7,
    topic: "product quality",
    postedAt: null,
    ingestedAt: new Date().toISOString(),
    status: "new",
  },
  {
    id: "demo-2",
    keywordId: "demo-kw",
    source: "ig-hashtag",
    sourceUrl: "https://instagram.com/p/demo",
    externalId: "demo-2",
    author: "fatimaboutros",
    authorHandle: "@fatimaboutros",
    authorReach: 1200,
    body: "تأخر طلبي من سَمِّمها أسبوع كامل ومحد رد علي 😡",
    lang: "ar",
    dialect: "gulf",
    sentiment: -0.8,
    topic: "delivery delay",
    postedAt: null,
    ingestedAt: new Date().toISOString(),
    status: "new",
  },
];
```

- [ ] **Step 2: Create the Mentions screen**

Create `src/screens/Mentions.tsx`:

```tsx
import { memo, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { Avatar } from "@/components/Avatar";
import { IconRadar, IconSend, IconStar } from "@/icons";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Mention, MentionStatus } from "@/lib/types";
import { DEMO_MENTIONS } from "@/data/mentions-extras";

type Filter = "all" | "new" | "negative" | "positive" | "triaged";

function sentimentColor(s: number | null): string {
  if (s === null) return "var(--ink-3)";
  if (s <= -0.3) return "var(--bad)";
  if (s >= 0.3) return "var(--ok)";
  return "var(--ink-2)";
}

function sentimentLabel(s: number | null): string {
  if (s === null) return "—";
  if (s <= -0.3) return "negative";
  if (s >= 0.3) return "positive";
  return "neutral";
}

function MentionsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";

  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const liveQ = useFetch<Mention[]>("/mentions");
  const data: Mention[] = useMemo(() => {
    if (liveQ.data && liveQ.data.length > 0) return liveQ.data;
    if (liveQ.loading) return [];
    return DEMO_MENTIONS;
  }, [liveQ.data, liveQ.loading]);

  const filtered = useMemo(() => {
    return data.filter((m) => {
      if (filter === "all") return true;
      if (filter === "new") return m.status === "new";
      if (filter === "triaged") return m.status === "triaged" || m.status === "engaged";
      if (filter === "negative") return (m.sentiment ?? 0) <= -0.3;
      if (filter === "positive") return (m.sentiment ?? 0) >= 0.3;
      return true;
    });
  }, [data, filter]);

  const selected = useMemo(
    () => filtered.find((m) => m.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const openTicket = useMutation<{ id: string }, { ticketId: string; contactId: string }>((input) =>
    api.post(`/mentions/${input.id}/open-ticket`, {}),
  );

  const updateStatus = useMutation<{ id: string; status: MentionStatus }, Mention>((input) =>
    api.patch(`/mentions/${input.id}`, { status: input.status }),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Mentions", "الإشارات")}
        subtitle={tx(
          "Brand mentions across web and Instagram — with sentiment and dialect",
          "إشارات العلامة عبر الويب وإنستغرام — مع المشاعر واللهجة",
        )}
        actions={
          <button className="btn">
            <IconStar w={13} />
            {tx("Saved", "المحفوظات")}
          </button>
        }
      />

      <div className="tabs" style={{ padding: "0 24px" }}>
        {(["all", "new", "negative", "positive", "triaged"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={`tab ${filter === f ? "active" : ""}`.trim()}
            onClick={() => setFilter(f)}
          >
            <span>{tx(f, { all: "الكل", new: "جديدة", negative: "سلبية", positive: "إيجابية", triaged: "تمت المعالجة" }[f])}</span>
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", flex: 1, minHeight: 0 }}>
        <div style={{ borderInlineEnd: "1px solid var(--line-soft)", overflowY: "auto" }}>
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedId(m.id)}
              style={{
                display: "flex",
                gap: 10,
                padding: 12,
                width: "100%",
                textAlign: "start",
                background: m.id === selected?.id ? "var(--accent-soft)" : "transparent",
                border: 0,
                borderBottom: "1px solid var(--line-soft)",
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
            >
              <Avatar name={m.author} color="200" size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{m.author}</span>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {m.source}
                  </span>
                  {m.dialect && (
                    <Badge kind="ai">{m.dialect}</Badge>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-2)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {m.body}
                </div>
                <div className="mono" style={{ fontSize: 11, color: sentimentColor(m.sentiment), marginTop: 2 }}>
                  {sentimentLabel(m.sentiment)}
                  {m.topic ? ` · ${m.topic}` : ""}
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="mono muted" style={{ padding: 16, fontSize: 12 }}>
              {tx("No mentions match this filter.", "لا توجد إشارات تطابق هذا الفلتر.")}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", overflowY: "auto" }}>
          {selected ? (
            <>
              <div style={{ padding: 18, borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <Avatar name={selected.author} color="200" size="lg" />
                  <div>
                    <div style={{ fontWeight: 600 }}>{selected.author}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {selected.source} · {selected.lang ?? "?"} {selected.dialect ? `(${selected.dialect})` : ""}
                    </div>
                  </div>
                  <span style={{ marginInlineStart: "auto" }}>
                    <Badge kind="ai">{sentimentLabel(selected.sentiment)}</Badge>
                  </span>
                </div>
                <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                  {isAr && selected.lang === "ar" ? selected.body : selected.body}
                </p>
                {selected.sourceUrl && (
                  <a className="mono" style={{ fontSize: 12 }} href={selected.sourceUrl} target="_blank" rel="noreferrer">
                    {tx("Open source", "افتح المصدر")} ↗
                  </a>
                )}
              </div>

              <div style={{ padding: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={openTicket.loading}
                  onClick={() => {
                    void openTicket.mutate({ id: selected.id }).then(() => liveQ.refetch?.());
                  }}
                >
                  <IconSend w={13} />
                  {tx("Open ticket", "افتح بطاقة")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={updateStatus.loading}
                  onClick={() => {
                    void updateStatus.mutate({ id: selected.id, status: "dismissed" }).then(() => liveQ.refetch?.());
                  }}
                >
                  {tx("Dismiss", "تجاهل")}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={updateStatus.loading}
                  onClick={() => {
                    void updateStatus.mutate({ id: selected.id, status: "engaged" }).then(() => liveQ.refetch?.());
                  }}
                >
                  {tx("Mark engaged", "تم التواصل")}
                </button>
                {openTicket.error && (
                  <span style={{ color: "var(--bad)", fontSize: 12 }}>{openTicket.error}</span>
                )}
              </div>
            </>
          ) : (
            <div className="mono muted" style={{ padding: 24, fontSize: 13 }}>
              <IconRadar w={14} /> {tx("Select a mention", "اختر إشارة")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const Mentions = memo(MentionsImpl);
export default Mentions;
```

- [ ] **Step 3: Typecheck**

```powershell
npm run typecheck
```

Expected: should now pass for Mentions. If `useFetch` does not expose a `refetch` method, replace `liveQ.refetch?.()` with a no-op or change to a manual refresh pattern matching the rest of the codebase. Inspect `src/api/useFetch.ts` to confirm.

- [ ] **Step 4: Start the dev server and verify in the browser**

```powershell
npm run dev
```

Open `http://localhost:5173/mentions`. Expected:
- The Mentions nav item appears in the sidebar with the radar icon.
- The screen renders. If the backend has no real mentions, the two demo mentions render.
- Filters work (clicking "negative" should leave only the second demo mention).
- Selecting a mention shows the detail panel with sentiment badge.
- Click "Open ticket" — should call the backend; if there's no default pipeline configured, you'll see an error. That's acceptable for this step.

- [ ] **Step 5: Commit**

```powershell
git add src/screens/Mentions.tsx src/data/mentions-extras.ts
git commit -m "feat(mentions): Mentions screen with filter, detail and open-ticket"
```

---

## Task 14: Keywords management screen

**Files:**
- Create: `src/screens/Keywords.tsx`

- [ ] **Step 1: Create the Keywords screen**

Create `src/screens/Keywords.tsx`:

```tsx
import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { IconPlus } from "@/icons";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Keyword, KeywordKind } from "@/lib/types";

const KIND_OPTIONS: KeywordKind[] = ["brand", "hashtag", "handle", "competitor"];

function KeywordsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const listQ = useFetch<Keyword[]>("/keywords");
  const [draft, setDraft] = useState<{ value: string; kind: KeywordKind }>({ value: "", kind: "brand" });

  const createKw = useMutation<{ value: string; kind: KeywordKind }, Keyword>((input) =>
    api.post("/keywords", input),
  );
  const deleteKw = useMutation<{ id: string }, { ok: true }>((input) =>
    api.delete(`/keywords/${input.id}`),
  );

  const submit = async () => {
    const value = draft.value.trim();
    if (!value) return;
    await createKw.mutate({ value, kind: draft.kind });
    setDraft({ value: "", kind: draft.kind });
    listQ.refetch?.();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 24 }}>
      <PageHeader
        title={tx("Tracked keywords", "الكلمات المتابَعة")}
        subtitle={tx(
          "Words, hashtags, handles and competitor names that the listener watches for.",
          "كلمات وعلامات وأسماء حسابات ومنافسين يراقبها النظام.",
        )}
      />

      <div style={{ display: "flex", gap: 8, padding: "12px 0" }}>
        <input
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          placeholder={tx("e.g. samemha or #صممها", "مثلاً samemha أو #صممها")}
          className="input"
          style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)" }}
        />
        <select
          value={draft.kind}
          onChange={(e) => setDraft({ ...draft, kind: e.target.value as KeywordKind })}
          className="input"
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg)" }}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button className="btn primary" type="button" disabled={createKw.loading} onClick={submit}>
          <IconPlus w={13} />
          {tx("Add", "إضافة")}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        {(listQ.data ?? []).map((k) => (
          <div
            key={k.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            <span style={{ fontWeight: 600 }}>{k.value}</span>
            <Badge kind="ai">{k.kind}</Badge>
            {!k.enabled && <Badge kind="ai">disabled</Badge>}
            <button
              type="button"
              className="btn ghost sm"
              style={{ marginInlineStart: "auto" }}
              disabled={deleteKw.loading}
              onClick={async () => {
                await deleteKw.mutate({ id: k.id });
                listQ.refetch?.();
              }}
            >
              {tx("Remove", "حذف")}
            </button>
          </div>
        ))}
        {(listQ.data ?? []).length === 0 && !listQ.loading && (
          <div className="mono muted" style={{ fontSize: 12 }}>
            {tx("No keywords yet — add your brand to start listening.", "لا توجد كلمات بعد — أضف اسم علامتك للبدء.")}
          </div>
        )}
      </div>
    </div>
  );
}

const Keywords = memo(KeywordsImpl);
export default Keywords;
```

- [ ] **Step 2: Typecheck and dev server check**

```powershell
npm run typecheck
```

Expected: pass. If `Badge` does not accept `kind="ai"` for arbitrary text, drop the Badge wrapper and inline a span. If `api.delete` is not a method, adjust to the actual client method (probably `api.del` or similar — inspect [src/api/client.ts](src/api/client.ts)).

Start `npm run dev`, open `http://localhost:5173/keywords`. Expected:
- Add a keyword "samemha" with kind "brand" — appears in the list.
- Remove it — disappears.
- Round-trip works against the backend.

- [ ] **Step 3: Commit**

```powershell
git add src/screens/Keywords.tsx
git commit -m "feat(keywords): keywords management screen"
```

---

## Task 15: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Backend + frontend running**

In two shells:

```powershell
# shell 1
npm --prefix backend run dev

# shell 2
npm run dev
```

- [ ] **Step 2: Add a keyword via the UI**

Browser: open `http://localhost:5173/keywords`. Add `samemha` as `brand`. Confirm it appears.

- [ ] **Step 3: Trigger a manual poll**

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/mentions/_admin/run" -Method Post
```

Expected: `{ scanned: N, ingested: M }`. If `M > 0`, you have real mentions.

- [ ] **Step 4: View mentions in the UI**

Browser: open `http://localhost:5173/mentions`. Expected: real mentions appear (or demo data if `M === 0`). Verify:
- Sentiment color coding on each row.
- Dialect badge for Arabic mentions.
- Filter buttons change the list.
- Detail panel shows sentiment + source link.

- [ ] **Step 5: Open a ticket from a mention**

Click "Open ticket" on a mention. Expected: success (no error toast). Navigate to `http://localhost:5173/pipeline`. Verify a new ticket appears in the first stage of the default pipeline, with the mention author as the contact.

- [ ] **Step 6: Final commit (if anything was tweaked)**

```powershell
git status
# If clean, no commit needed. If there were tiny fixes:
git add .
git commit -m "fix(mentions): minor adjustments from e2e verification"
```

---

## Self-Review

**Spec coverage:**
- Mentions ingestion (backend module) — Tasks 5-10 ✓
- Google CSE channel — Task 7 ✓
- Meta IG hashtag channel — Task 7 ✓
- Claude Haiku enrichment (lang/sentiment/dialect/topic) — Task 4 ✓
- Mentions in the UI (separate screen, not Inbox — deliberate trade-off) — Task 13 ✓
- One-click "open ticket from mention" — Tasks 9 + 13 ✓
- Keyword management — Tasks 5 + 14 ✓
- Cron polling (every 30 min) + manual trigger — Task 8 ✓
- Schema migration including nullable `Contact.phone` — Tasks 1-2 ✓
- Agents intentionally untouched ✓

**Placeholder scan:** no "TBD", "implement later", or "similar to Task N" patterns remain. Every code step contains complete code.

**Type consistency:**
- `MentionStatus` values consistent across backend (`mentions.dto.ts`) and frontend (`types.ts`): `"new" | "triaged" | "engaged" | "dismissed"` ✓
- `MentionSource` values consistent: `"google" | "ig-hashtag" | "fb-page" | "news"` ✓
- `KeywordKind` values consistent: `"brand" | "hashtag" | "handle" | "competitor"` ✓
- `MentionDialect` values consistent: `"msa" | "gulf" | "egyptian" | "levantine" | "maghrebi"` ✓
- Endpoint paths consistent: `/keywords`, `/mentions`, `/mentions/:id/open-ticket`, `/mentions/_admin/run` ✓

**Known fragilities (deliberate, document but don't fix in Phase 1):**
- Single-tenant: no `workspaceId` on Mention/Keyword. When tkana grows multi-tenant, add it and backfill.
- `useFetch.refetch?.()` is assumed; if the actual API differs the executing agent must adapt during Task 13/14.
- `api.delete` method assumed; verify against [src/api/client.ts](src/api/client.ts) during Task 14.
- Google CSE is shared per workspace — when multi-tenant is added, each workspace will need its own CSE id.
- Meta IG hashtag search requires the existing Instagram integration to be connected with `instagram_basic` + `pages_show_list` + `instagram_manage_insights`; if not, the poller silently skips with a warning log.
- No retry/backoff for Anthropic 429s — acceptable for Phase 1 volumes; revisit if mention volume exceeds ~1k/day.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-mentions-listening-phase-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration with isolated context per step.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for your review.

Which approach?
