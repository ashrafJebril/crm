# WhatsApp AI Assistant MVP — Phase 1 Implementation Plan (pgvector + Neon)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the end-to-end loop where (1) an admin uploads PDF/DOCX/text files as a per-workspace knowledge base, (2) inbound WhatsApp messages trigger an AI reply that retrieves answers from the KB via pgvector cosine similarity, and (3) low-confidence replies escalate to a human in the Inbox.

**Architecture:** Migrate dev DB from SQLite to Neon Postgres with the `pgvector` extension. Documents are parsed (pdf-parse/mammoth), chunked with a recursive character splitter, embedded via OpenAI `text-embedding-3-small` (1536 dims), and stored with the embedding column typed as `Unsupported("vector(1536)")` plus an HNSW cosine index. Reply path: cosine-similarity top-K retrieval → inject chunks into the system prompt → OpenAI Responses API with **structured outputs** (JSON schema) returning `{action, reply, confidence, ...}`. Webhook→reply is synchronous in this phase (defer BullMQ to Plan 2). Existing `Conversation.escalated` boolean is reused; a dedicated `Escalation` model is deferred to Plan 3.

**Tech Stack:**
- DB: Neon Postgres 16 + pgvector
- Backend: NestJS 10, Prisma 5 (migrate, not push)
- Parsing: `pdf-parse`, `mammoth`
- AI: `openai` SDK v4 (Responses API + Embeddings)
- WhatsApp: Meta Cloud API v21.0 (already integrated)
- File upload: `multer`
- Tests: Jest (new, scoped to AI + retrieval logic)

---

## File Structure

**New files:**
- `backend/src/openai/openai.module.ts`
- `backend/src/openai/openai.service.ts` — client wrapper, embedding helper
- `backend/src/knowledge/knowledge.module.ts`
- `backend/src/knowledge/knowledge.controller.ts` — `/knowledge/documents` CRUD with multer
- `backend/src/knowledge/knowledge.service.ts` — orchestrator: parse → chunk → embed → persist
- `backend/src/knowledge/parsers.ts` — PDF/DOCX/TXT/MD text extraction
- `backend/src/knowledge/chunker.ts` — recursive character splitter (Arabic-aware)
- `backend/src/knowledge/chunker.spec.ts` — Jest tests
- `backend/src/knowledge/knowledge-search.service.ts` — top-K similarity via `$queryRaw`
- `backend/src/knowledge/knowledge.dto.ts`
- `backend/src/ai/ai.module.ts`
- `backend/src/ai/ai-reply.service.ts` — `generate()` → structured JSON
- `backend/src/ai/ai-reply.service.spec.ts`
- `backend/jest.config.js`
- `src/api/knowledge.ts` — typed frontend client

**Modified files:**
- `backend/prisma/schema.prisma` — `provider = "postgresql"`; add `KnowledgeDocument` + `KnowledgeChunk` models; extend `Workspace` (aiAutoReplyEnabled, aiConfidenceThreshold); add inverse relations
- `backend/prisma/migrations/` — NEW directory (we switch from `db push` to `migrate`)
- `backend/src/app.module.ts` — register `OpenAiModule`, `KnowledgeModule`, `AiModule`
- `backend/src/integrations/whatsapp.service.ts` — `ingestInbound()` invokes AI reply pipeline
- `backend/src/integrations/integrations.module.ts` — import `AiModule`
- `backend/package.json` — add `openai`, `multer`, `pdf-parse`, `mammoth`, `jest`, `ts-jest`, `@types/jest`, `@types/pdf-parse`, `@types/multer` (already)
- `backend/.env.example` / `backend/.env` — Neon `DATABASE_URL`, OpenAI keys, threshold
- `src/screens/Agents.tsx` — Knowledge tab wired to backend
- `src/screens/Inbox.tsx` — "AI" badge on auto-reply messages

---

## Pre-flight (already done by user)

- ✅ Neon project created in `eu-central-1` (Frankfurt)
- ✅ Neon `DATABASE_URL` in `backend/.env`
- ✅ `OPENAI_API_KEY` in `backend/.env`

---

## Phase 0 — Foundation

### Task 1: Branch + commit existing WhatsApp work

**Files:** the uncommitted WhatsApp files + current branch state.

- [ ] **Step 1: Stash unrelated frontend WIP**

The current branch has 16 modified frontend files unrelated to WhatsApp. Stash them so the first commit is clean:

```bash
git stash push -m "social-publisher WIP — resume later" -- \
  src/auth/context.tsx src/data/templates-extras.ts src/lib/types.ts \
  src/screens/Admin.tsx src/screens/Calendar.tsx src/screens/Campaigns.tsx \
  src/screens/Contacts.tsx src/screens/Inbox.tsx src/screens/Pipeline.tsx \
  src/screens/Social.tsx src/screens/Templates.tsx \
  src/screens/settings/IntegrationsTab.tsx src/shell/Topbar.tsx
```

- [ ] **Step 2: Branch from current**

```bash
git checkout -b feat/whatsapp-ai-mvp
```

- [ ] **Step 3: Commit the WhatsApp Cloud API work**

```bash
git add backend/src/integrations/whatsapp.controller.ts \
        backend/src/integrations/whatsapp.dto.ts \
        backend/src/integrations/whatsapp.service.ts \
        backend/src/integrations/integrations.module.ts \
        backend/src/templates/templates.module.ts \
        backend/prisma/schema.prisma
git commit -m "feat(whatsapp): Cloud API send/receive + template lifecycle"
```

- [ ] **Step 4: Verify clean tree**

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

---

### Task 2: Install dependencies

**Files:** `backend/package.json`

- [ ] **Step 1: Install runtime deps**

```bash
cd backend
npm install openai@^4.71.0 multer@^1.4.5-lts.1 pdf-parse@^1.1.1 mammoth@^1.8.0
```

- [ ] **Step 2: Install dev deps**

```bash
npm install -D jest@^29.7.0 ts-jest@^29.2.5 @types/jest@^29.5.14 @types/pdf-parse@^1.1.4
```

- [ ] **Step 3: Add test + migrate scripts**

Edit `backend/package.json` `scripts` block — add `test` and `migrate`:

```json
"scripts": {
  "prebuild": "rimraf dist",
  "build": "nest build",
  "start": "nest start",
  "dev": "nest start --watch",
  "start:prod": "node dist/main",
  "prisma:generate": "prisma generate",
  "prisma:push": "prisma db push",
  "prisma:studio": "prisma studio",
  "prisma:migrate": "prisma migrate dev",
  "prisma:deploy": "prisma migrate deploy",
  "seed": "tsx prisma/seed.ts",
  "reset": "prisma migrate reset --force && tsx prisma/seed.ts",
  "test": "jest"
}
```

- [ ] **Step 4: Create Jest config**

Create `backend/jest.config.js`:

```js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testRegex: ".*\\.spec\\.ts$",
  moduleFileExtensions: ["ts", "js", "json"],
};
```

- [ ] **Step 5: Verify Jest finds nothing yet**

```bash
npm test -- --passWithNoTests
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/jest.config.js
git commit -m "chore(backend): add openai, multer, pdf-parse, mammoth, jest"
```

---

### Task 3: Update env files

**Files:** `backend/.env.example`, `backend/.env`

- [ ] **Step 1: Update .env.example**

Replace the `# Database` block in `backend/.env.example` and append OpenAI block:

```
# Database (Neon Postgres + pgvector)
DATABASE_URL=postgresql://USER:PASS@HOST/DB?sslmode=require

# OpenAI (AI replies + KB embeddings)
OPENAI_API_KEY=
OPENAI_REPLY_MODEL=gpt-4o-mini
OPENAI_EMBED_MODEL=text-embedding-3-small
AI_REPLY_CONFIDENCE_THRESHOLD=0.75
```

- [ ] **Step 2: Verify backend/.env has the Neon URL + OPENAI_API_KEY**

(User already pasted these. Sanity check by reading the file — do not modify.)

```bash
grep -E "^(DATABASE_URL|OPENAI_API_KEY)=" backend/.env
```

Expected: both lines present with non-empty values. If either is missing, stop and add it.

- [ ] **Step 3: Commit .env.example only**

```bash
git add backend/.env.example
git commit -m "chore(env): switch DATABASE_URL to Neon Postgres + add OpenAI vars"
```

---

### Task 4: Migrate Prisma to Postgres + enable pgvector

**Files:** `backend/prisma/schema.prisma`, `backend/prisma/migrations/`

- [ ] **Step 1: Switch the datasource provider**

In `backend/prisma/schema.prisma`, change the datasource block from:

```prisma
// SQLite for dev. Switch `provider` to "postgresql" for prod.

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

to:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [vector]
}
```

- [ ] **Step 2: Delete the SQLite dev DB file (if present)**

```bash
rm -f backend/prisma/dev.db backend/dev.db
```

- [ ] **Step 3: Generate the first migration**

```bash
cd backend
npx prisma migrate dev --name init_postgres
```

Expected output: creates `prisma/migrations/<timestamp>_init_postgres/migration.sql`, applies it to Neon, regenerates the client.

If you hit shadow-database errors (Neon free tier doesn't allow CREATE DATABASE), pass an explicit shadow URL or create a second Neon branch and set `shadowDatabaseUrl`. Quick fix — append to the datasource:

```prisma
datasource db {
  provider          = "postgresql"
  url               = env("DATABASE_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
  extensions        = [vector]
}
```

…and add `SHADOW_DATABASE_URL=` to `.env` pointing at a second Neon branch you created in the dashboard.

- [ ] **Step 4: Verify pgvector extension is enabled**

Open `prisma/migrations/<timestamp>_init_postgres/migration.sql` — at the very top there should be:

```sql
CREATE EXTENSION IF NOT EXISTS "vector";
```

If absent (Prisma 5.x writes this only when an `Unsupported("vector(...)")` column exists, which we haven't added yet), add it manually as the first line of the migration file, then re-apply:

```bash
npx prisma migrate resolve --rolled-back "<timestamp>_init_postgres"
npx prisma migrate deploy
```

A cleaner alternative — create the extension via a separate explicit migration:

```bash
npx prisma migrate dev --create-only --name enable_pgvector
```

…then in the empty SQL file add `CREATE EXTENSION IF NOT EXISTS "vector";` and run `npx prisma migrate dev`.

- [ ] **Step 5: Re-seed the database**

```bash
npm run seed
```

Expected: seed runs against Neon, populates default workspace/users/etc.

- [ ] **Step 6: Smoke test backend boot**

```bash
npm run dev
```

Expected: server listens on :3001, no Prisma errors. Stop with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(db): migrate to Neon Postgres + enable pgvector extension"
```

---

### Task 5: OpenAiService — client + embeddings

**Files:** `backend/src/openai/openai.module.ts`, `backend/src/openai/openai.service.ts`

- [ ] **Step 1: Create OpenAiService**

Create `backend/src/openai/openai.service.ts`:

```typescript
import { Injectable, Logger } from "@nestjs/common";
import OpenAI from "openai";

@Injectable()
export class OpenAiService {
  private readonly log = new Logger(OpenAiService.name);
  private _client: OpenAI | null = null;

  /** Lazy-initialised client. Throws if OPENAI_API_KEY is not set. */
  get client(): OpenAI {
    if (this._client) return this._client;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. AI features require a key in backend/.env",
      );
    }
    this._client = new OpenAI({ apiKey });
    return this._client;
  }

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  get replyModel(): string {
    return process.env.OPENAI_REPLY_MODEL || "gpt-4o-mini";
  }

  get embedModel(): string {
    return process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  }

  get confidenceThreshold(): number {
    const raw = process.env.AI_REPLY_CONFIDENCE_THRESHOLD;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 0.75;
  }

  /** Batch-embed an array of strings. Returns one float[] per input, in order. */
  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.embedModel,
      input: inputs,
    });
    // Sort by `index` to defend against any future reordering.
    return [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);
  }
}
```

- [ ] **Step 2: Create OpenAiModule**

Create `backend/src/openai/openai.module.ts`:

```typescript
import { Global, Module } from "@nestjs/common";
import { OpenAiService } from "./openai.service";

@Global()
@Module({
  providers: [OpenAiService],
  exports: [OpenAiService],
})
export class OpenAiModule {}
```

- [ ] **Step 3: Register in AppModule**

Edit `backend/src/app.module.ts` — add `OpenAiModule` to the imports array:

```typescript
import { OpenAiModule } from "./openai/openai.module";
// ...
imports: [
  // existing modules...
  OpenAiModule,
],
```

- [ ] **Step 4: Build**

```bash
cd backend
npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/openai backend/src/app.module.ts
git commit -m "feat(openai): global service with chat + embeddings helpers"
```

---

## Phase 1 — Knowledge Base (pgvector)

### Task 6: Schema — KnowledgeDocument + KnowledgeChunk + Workspace fields

**Files:** `backend/prisma/schema.prisma`, new migration

- [ ] **Step 1: Add fields to Workspace**

Find the `model Workspace { ... }` block and add (before the closing brace):

```prisma
  aiAutoReplyEnabled    Boolean @default(false)
  aiConfidenceThreshold Float?

  knowledgeDocs KnowledgeDocument[] @relation("WorkspaceKnowledge")
  knowledgeChunks KnowledgeChunk[]   @relation("WorkspaceKnowledgeChunks")
```

- [ ] **Step 2: Add inverse relation on User**

In `model User`, add (alongside other relations):

```prisma
  knowledgeUploads KnowledgeDocument[] @relation("UserKnowledgeUploads")
```

- [ ] **Step 3: Add KnowledgeDocument + KnowledgeChunk**

Append to `backend/prisma/schema.prisma`:

```prisma
model KnowledgeDocument {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation("WorkspaceKnowledge", fields: [workspaceId], references: [id], onDelete: Cascade)

  filename  String
  mimeType  String
  sizeBytes Int

  // "pending" | "processing" | "ready" | "failed"
  status     String  @default("pending")
  errorText  String?
  chunkCount Int     @default(0)

  uploadedByUserId String?
  uploadedBy       User?    @relation("UserKnowledgeUploads", fields: [uploadedByUserId], references: [id], onDelete: SetNull)

  chunks KnowledgeChunk[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([workspaceId])
}

model KnowledgeChunk {
  id                  String @id @default(cuid())
  workspaceId         String
  workspace           Workspace         @relation("WorkspaceKnowledgeChunks", fields: [workspaceId], references: [id], onDelete: Cascade)
  knowledgeDocumentId String
  knowledgeDocument   KnowledgeDocument @relation(fields: [knowledgeDocumentId], references: [id], onDelete: Cascade)

  chunkIndex Int
  content    String
  tokenCount Int

  // pgvector column; Prisma can't typecheck it, so we read/write via $queryRaw.
  embedding Unsupported("vector(1536)")

  createdAt DateTime @default(now())

  @@index([workspaceId])
  @@index([knowledgeDocumentId])
}
```

- [ ] **Step 4: Generate the migration**

```bash
cd backend
npx prisma migrate dev --name add_knowledge_base
```

Expected: creates the tables. Prisma writes the `vector(1536)` column via `Unsupported`.

- [ ] **Step 5: Add HNSW index (manual SQL)**

Open the generated `prisma/migrations/<timestamp>_add_knowledge_base/migration.sql` and append at the bottom:

```sql
-- HNSW cosine-similarity index for fast top-K retrieval.
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON "KnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops);
```

Then re-apply:

```bash
npx prisma migrate dev
```

(Prisma will detect the file changed and reapply via reset; alternatively run the SQL via `psql $DATABASE_URL`.)

If Prisma complains that the migration is already applied and won't re-run, run the index DDL directly:

```bash
psql "$DATABASE_URL" -c 'CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx ON "KnowledgeChunk" USING hnsw (embedding vector_cosine_ops);'
```

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(schema): KnowledgeDocument + KnowledgeChunk with pgvector HNSW index"
```

---

### Task 7: Chunker — TDD

**Files:** `backend/src/knowledge/chunker.ts`, `backend/src/knowledge/chunker.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/knowledge/chunker.spec.ts`:

```typescript
import { splitIntoChunks, estimateTokens } from "./chunker";

describe("chunker.splitIntoChunks", () => {
  it("returns the original text as one chunk when below max size", () => {
    const text = "Short paragraph.";
    const chunks = splitIntoChunks(text, { maxChars: 1000, overlapChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short paragraph.");
  });

  it("splits long text on paragraph boundaries first", () => {
    const text = "A".repeat(500) + "\n\n" + "B".repeat(500) + "\n\n" + "C".repeat(500);
    const chunks = splitIntoChunks(text, { maxChars: 600, overlapChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk exceeds the size limit (plus a little tolerance for overlap merge).
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(700);
  });

  it("includes overlap between consecutive chunks", () => {
    const text = "word ".repeat(400); // ~2000 chars
    const chunks = splitIntoChunks(text, { maxChars: 500, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    // Last 50 chars of chunk[0] should appear at the start of chunk[1].
    const tail = chunks[0].slice(-50);
    expect(chunks[1].startsWith(tail.slice(0, 30))).toBe(true);
  });

  it("handles Arabic text with Arabic punctuation", () => {
    const ar = "كيف حالك؟\n\nأنا بخير، شكراً لك.\n\nما هي ساعات العمل؟";
    const chunks = splitIntoChunks(ar, { maxChars: 100, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("ساعات");
  });

  it("never returns an empty chunk", () => {
    const text = "\n\n\n\nhello\n\n\n\n";
    const chunks = splitIntoChunks(text, { maxChars: 100, overlapChars: 10 });
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
  });
});

describe("chunker.estimateTokens", () => {
  it("estimates ~1 token per ~4 chars for English", () => {
    const t = estimateTokens("hello world this is a test sentence");
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(15);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd backend
npm test -- chunker
```

Expected: FAIL — `Cannot find module './chunker'`.

- [ ] **Step 3: Implement the chunker**

Create `backend/src/knowledge/chunker.ts`:

```typescript
export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

/**
 * Recursive character splitter — tries to keep semantic units together by
 * splitting on the largest available boundary first (paragraph → line →
 * sentence → word). Arabic-aware: treats `؟`, `۔`, `،` and the newline forms
 * as sentence/clause boundaries.
 *
 * Roughly mirrors LangChain's RecursiveCharacterTextSplitter but with no
 * external deps.
 */
export function splitIntoChunks(text: string, opts: ChunkOptions): string[] {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  if (t.length <= opts.maxChars) return [t];

  const separators = ["\n\n", "\n", "؟ ", "? ", "۔ ", ". ", "، ", ", ", " "];
  const pieces = splitRecursive(t, separators, opts.maxChars);

  // Merge small pieces back into ~maxChars chunks with overlap.
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!p) continue;
    if (cur.length + p.length + 1 <= opts.maxChars) {
      cur = cur ? cur + " " + p : p;
    } else {
      if (cur) out.push(cur);
      // Start the next chunk with overlap from the tail of the previous one.
      const overlap = cur.slice(-opts.overlapChars);
      cur = overlap ? overlap + " " + p : p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((c) => c.trim().length > 0);
}

function splitRecursive(text: string, separators: string[], maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  if (separators.length === 0) {
    // Hard split — no separator small enough.
    const out: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
    return out;
  }
  const [sep, ...rest] = separators;
  const parts = text.split(sep);
  if (parts.length === 1) return splitRecursive(text, rest, maxChars);
  const out: string[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    if (part.length <= maxChars) out.push(part);
    else out.push(...splitRecursive(part, rest, maxChars));
  }
  return out;
}

/** Cheap token estimate — ~4 chars per token for English, ~2 for Arabic-heavy. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}
```

- [ ] **Step 4: Run tests until green**

```bash
npm test -- chunker
```

Expected: all chunker tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/knowledge/chunker.ts backend/src/knowledge/chunker.spec.ts
git commit -m "feat(knowledge): recursive Arabic-aware character splitter (TDD)"
```

---

### Task 8: Parsers (PDF/DOCX/TXT/MD)

**Files:** `backend/src/knowledge/parsers.ts`

- [ ] **Step 1: Create parser module**

Create `backend/src/knowledge/parsers.ts`:

```typescript
import * as mammoth from "mammoth";
import pdfParse from "pdf-parse";

/** Extract plain text from an uploaded file by mime type. */
export async function extractText(file: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}): Promise<string> {
  switch (file.mimetype) {
    case "application/pdf":
      return parsePdf(file.buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocx(file.buffer);
    case "text/plain":
    case "text/markdown":
      return file.buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file type: ${file.mimetype}`);
  }
}

async function parsePdf(buf: Buffer): Promise<string> {
  const result = await pdfParse(buf);
  return result.text.trim();
}

async function parseDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value.trim();
}
```

- [ ] **Step 2: Build to verify type wiring**

```bash
cd backend
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/knowledge/parsers.ts
git commit -m "feat(knowledge): PDF/DOCX/TXT text extraction"
```

---

### Task 9: KnowledgeService — orchestrator

**Files:** `backend/src/knowledge/knowledge.service.ts`, `backend/src/knowledge/knowledge.dto.ts`

- [ ] **Step 1: Create DTO**

Create `backend/src/knowledge/knowledge.dto.ts`:

```typescript
export interface KnowledgeDocumentDto {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  errorText: string | null;
  chunkCount: number;
  createdAt: string;
}
```

- [ ] **Step 2: Create the service**

Create `backend/src/knowledge/knowledge.service.ts`:

```typescript
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiService } from "../openai/openai.service";
import { extractText } from "./parsers";
import { splitIntoChunks, estimateTokens } from "./chunker";
import type { KnowledgeDocumentDto } from "./knowledge.dto";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const CHUNK_MAX_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;

@Injectable()
export class KnowledgeService {
  private readonly log = new Logger(KnowledgeService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
  ) {}

  async list(workspaceId: string): Promise<KnowledgeDocumentDto[]> {
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(this.toDto);
  }

  async upload(
    workspaceId: string,
    userId: string | null,
    file: Express.Multer.File,
  ): Promise<KnowledgeDocumentDto> {
    if (!file) throw new BadRequestException("No file uploaded");
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: PDF, TXT, MD, DOCX.`,
      );
    }
    if (!this.openai.isConfigured()) {
      throw new BadRequestException("OPENAI_API_KEY not configured");
    }

    // Create the row up-front so the user sees pending status immediately.
    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        workspaceId,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        status: "processing",
        uploadedByUserId: userId,
      },
    });

    // Process synchronously for MVP — small docs only.
    try {
      const text = await extractText({
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
      if (!text.trim()) throw new Error("Document is empty or unreadable");

      const chunks = splitIntoChunks(text, {
        maxChars: CHUNK_MAX_CHARS,
        overlapChars: CHUNK_OVERLAP_CHARS,
      });
      if (chunks.length === 0) throw new Error("No chunks extracted");

      // OpenAI embeddings allow up to ~2048 inputs/batch; chunk the chunks.
      const BATCH = 96;
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vecs = await this.openai.embed(slice);
        embeddings.push(...vecs);
      }
      if (embeddings.length !== chunks.length) {
        throw new Error(
          `embedding count mismatch: chunks=${chunks.length} vecs=${embeddings.length}`,
        );
      }

      // Insert chunks via $executeRawUnsafe so we can write the vector literal.
      // (Prisma 5 has no native vector type; the column is Unsupported.)
      for (let i = 0; i < chunks.length; i++) {
        const vectorLiteral = `[${embeddings[i].join(",")}]`;
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "KnowledgeChunk"
             ("id","workspaceId","knowledgeDocumentId","chunkIndex","content","tokenCount","embedding")
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          cuid(),
          workspaceId,
          doc.id,
          i,
          chunks[i],
          estimateTokens(chunks[i]),
          vectorLiteral,
        );
      }

      const updated = await this.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "ready", chunkCount: chunks.length },
      });
      return this.toDto(updated);
    } catch (err) {
      const msg = (err as Error).message;
      this.log.error(`KB upload failed for doc=${doc.id}: ${msg}`);
      const failed = await this.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "failed", errorText: msg.slice(0, 500) },
      });
      return this.toDto(failed);
    }
  }

  async remove(workspaceId: string, id: string): Promise<{ ok: true }> {
    const row = await this.prisma.knowledgeDocument.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Knowledge document not found");
    // Cascade deletes the chunks (FK has onDelete: Cascade).
    await this.prisma.knowledgeDocument.delete({ where: { id: row.id } });
    return { ok: true };
  }

  private toDto = (r: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    errorText: string | null;
    chunkCount: number;
    createdAt: Date;
  }): KnowledgeDocumentDto => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    status: r.status,
    errorText: r.errorText,
    chunkCount: r.chunkCount,
    createdAt: r.createdAt.toISOString(),
  });
}

// Tiny inline cuid generator — avoids adding a `cuid` dep when Prisma already
// has one transitively, but importing Prisma's internal isn't worth it.
function cuid(): string {
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}
```

- [ ] **Step 3: Build**

```bash
cd backend
npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/src/knowledge/knowledge.service.ts backend/src/knowledge/knowledge.dto.ts
git commit -m "feat(knowledge): orchestrator service (parse → chunk → embed → pgvector)"
```

---

### Task 10: KnowledgeController + module + AppModule wiring

**Files:** `backend/src/knowledge/knowledge.controller.ts`, `backend/src/knowledge/knowledge.module.ts`, `backend/src/app.module.ts`

- [ ] **Step 1: Create controller**

Create `backend/src/knowledge/knowledge.controller.ts`:

```typescript
import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { AuthGuard } from "../auth/auth.guard";
import { KnowledgeService } from "./knowledge.service";
import type { KnowledgeDocumentDto } from "./knowledge.dto";

interface AuthedRequest {
  user: { sub: string; workspaceId: string; role?: string };
}

@UseGuards(AuthGuard)
@Controller("knowledge")
export class KnowledgeController {
  constructor(private readonly svc: KnowledgeService) {}

  @Get("documents")
  list(@Req() req: AuthedRequest): Promise<KnowledgeDocumentDto[]> {
    return this.svc.list(req.user.workspaceId);
  }

  @Post("documents")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }))
  upload(
    @Req() req: AuthedRequest,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<KnowledgeDocumentDto> {
    return this.svc.upload(req.user.workspaceId, req.user.sub, file);
  }

  @Delete("documents/:id")
  remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.svc.remove(req.user.workspaceId, id);
  }
}
```

> If the auth guard import path is different, run `grep -rln "AuthGuard" backend/src/auth` to find it.

- [ ] **Step 2: Create module**

Create `backend/src/knowledge/knowledge.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeService } from "./knowledge.service";

@Module({
  imports: [PrismaModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
```

- [ ] **Step 3: Register in AppModule**

Add `KnowledgeModule` to the imports array in `backend/src/app.module.ts`.

- [ ] **Step 4: Manual round-trip test**

```bash
cd backend
npm run dev
```

In another shell — get a JWT for an existing workspace (use the existing login endpoint or inspect Prisma Studio for an existing one), then:

```bash
curl -X POST http://localhost:3001/knowledge/documents \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@./README.md"
```

Expected: JSON with `status: "ready"`, `chunkCount > 0`.

```bash
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3001/knowledge/documents
```

Expected: array of 1 doc.

Verify chunks exist:

```bash
psql "$DATABASE_URL" -c 'SELECT id, "chunkIndex", left(content, 60) FROM "KnowledgeChunk" LIMIT 5;'
```

Expected: 1+ rows with non-empty content.

- [ ] **Step 5: Commit**

```bash
git add backend/src/knowledge backend/src/app.module.ts
git commit -m "feat(knowledge): REST endpoints + module wiring"
```

---

### Task 11: KnowledgeSearchService — top-K similarity (TDD-lite)

**Files:** `backend/src/knowledge/knowledge-search.service.ts`

- [ ] **Step 1: Create the service**

Create `backend/src/knowledge/knowledge-search.service.ts`:

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiService } from "../openai/openai.service";

export interface KnowledgeSearchHit {
  chunkId: string;
  documentId: string;
  documentFilename: string;
  content: string;
  similarity: number; // 0..1 (higher = more similar)
}

@Injectable()
export class KnowledgeSearchService {
  private readonly log = new Logger(KnowledgeSearchService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
  ) {}

  /**
   * Embed the query and return the top-K most similar chunks for a workspace.
   * Uses pgvector cosine distance (`<=>`); similarity = 1 - distance.
   */
  async search(
    workspaceId: string,
    query: string,
    topK = 5,
  ): Promise<KnowledgeSearchHit[]> {
    if (!query.trim()) return [];
    const [vec] = await this.openai.embed([query]);
    const literal = `[${vec.join(",")}]`;

    // Raw SQL — we can't filter/order by the Unsupported vector column via Prisma.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        chunkId: string;
        documentId: string;
        documentFilename: string;
        content: string;
        distance: number;
      }>
    >(
      `SELECT
         c."id"                   AS "chunkId",
         c."knowledgeDocumentId"  AS "documentId",
         d."filename"             AS "documentFilename",
         c."content"              AS "content",
         c."embedding" <=> $1::vector AS "distance"
       FROM "KnowledgeChunk" c
       JOIN "KnowledgeDocument" d ON d."id" = c."knowledgeDocumentId"
       WHERE c."workspaceId" = $2 AND d."status" = 'ready'
       ORDER BY c."embedding" <=> $1::vector ASC
       LIMIT $3`,
      literal,
      workspaceId,
      topK,
    );

    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentFilename: r.documentFilename,
      content: r.content,
      similarity: 1 - Number(r.distance),
    }));
  }
}
```

- [ ] **Step 2: Add it to KnowledgeModule providers**

Edit `backend/src/knowledge/knowledge.module.ts`:

```typescript
import { KnowledgeSearchService } from "./knowledge-search.service";
// ...
providers: [KnowledgeService, KnowledgeSearchService],
exports: [KnowledgeService, KnowledgeSearchService],
```

- [ ] **Step 3: Manual smoke test via a one-off script**

Create a temp file `backend/tmp/test-search.ts`:

```typescript
import { PrismaService } from "../src/prisma/prisma.service";
import { OpenAiService } from "../src/openai/openai.service";
import { KnowledgeSearchService } from "../src/knowledge/knowledge-search.service";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaService(); // or new PrismaClient() if the wrapper has DI-only ctor
  const ai = new OpenAiService();
  const svc = new KnowledgeSearchService(prisma as never, ai);
  const ws = await (prisma as unknown as PrismaClient).workspace.findFirst();
  if (!ws) { console.log("no workspace"); return; }
  const hits = await svc.search(ws.id, "What are your delivery times?", 5);
  for (const h of hits) console.log(`${h.similarity.toFixed(3)} ${h.documentFilename}: ${h.content.slice(0, 80)}…`);
}
main().finally(() => process.exit(0));
```

Run:

```bash
cd backend
npx tsx tmp/test-search.ts
```

Expected: prints 0-5 hits with similarity scores. If 0, your KB doesn't have relevant content — upload a richer doc first.

Delete the temp file after:

```bash
rm backend/tmp/test-search.ts
```

- [ ] **Step 4: Build + commit**

```bash
npm run build
git add backend/src/knowledge/knowledge-search.service.ts backend/src/knowledge/knowledge.module.ts
git commit -m "feat(knowledge): top-K cosine similarity search via pgvector"
```

---

### Task 12: Frontend — Knowledge tab in Agents screen

**Files:** `src/api/knowledge.ts`, `src/screens/Agents.tsx`

- [ ] **Step 1: Find the existing API client pattern**

Look at an existing client file (e.g. `src/api/contacts.ts` or wherever your existing screens fetch) to learn the `apiUrl` + `authHeaders` helpers used in this codebase. Match the same import style.

```bash
grep -rln "Authorization.*Bearer" src/api 2>/dev/null || \
grep -rln "Authorization.*Bearer" src/ | head
```

- [ ] **Step 2: Create knowledge client**

Create `src/api/knowledge.ts`. Adjust the helper imports to match what you found:

```typescript
// Adjust this import to match your existing helpers
import { apiUrl, authHeaders } from "./client";

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;          // "pending" | "processing" | "ready" | "failed"
  errorText: string | null;
  chunkCount: number;
  createdAt: string;
}

export async function listKnowledge(): Promise<KnowledgeDocument[]> {
  const res = await fetch(apiUrl("/knowledge/documents"), { headers: authHeaders() });
  if (!res.ok) throw new Error(`list knowledge failed: ${res.status}`);
  return res.json();
}

export async function uploadKnowledge(file: File): Promise<KnowledgeDocument> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(apiUrl("/knowledge/documents"), {
    method: "POST",
    headers: authHeaders(), // do NOT set Content-Type — let the browser pick the multipart boundary
    body: fd,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json();
}

export async function deleteKnowledge(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/knowledge/documents/${id}`), {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
}
```

- [ ] **Step 3: Wire the Knowledge tab in `src/screens/Agents.tsx`**

Replace the existing static knowledge-tab block with a real component. Drop this near the top of `Agents.tsx`:

```tsx
import { useEffect, useState } from "react";
import { listKnowledge, uploadKnowledge, deleteKnowledge, KnowledgeDocument } from "../api/knowledge";

function KnowledgeTab() {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try { setDocs(await listKnowledge()); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { refresh(); }, []);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setError(null);
    try { await uploadKnowledge(f); await refresh(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); e.target.value = ""; }
  }

  async function onDelete(id: string) {
    setBusy(true);
    try { await deleteKnowledge(id); await refresh(); }
    finally { setBusy(false); }
  }

  return (
    <div className="knowledge-tab">
      <label className="btn">
        {busy ? "Uploading…" : "Upload PDF / DOCX / TXT"}
        <input type="file" accept=".pdf,.txt,.md,.docx" hidden onChange={onPickFile} disabled={busy} />
      </label>
      {error && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>File</th><th>Size</th><th>Chunks</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td>{d.filename}</td>
              <td>{(d.sizeBytes / 1024).toFixed(0)} KB</td>
              <td>{d.chunkCount}</td>
              <td>{d.status}{d.errorText ? ` — ${d.errorText}` : ""}</td>
              <td><button onClick={() => onDelete(d.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Then replace whatever the Knowledge tab renders today with `<KnowledgeTab />`.

- [ ] **Step 4: Visual verification**

Start frontend (`npm run dev` in repo root). Log in → Agents → Knowledge → upload a small PDF. Confirm row appears with `status=ready` and `chunkCount > 0`.

- [ ] **Step 5: Commit**

```bash
git add src/api/knowledge.ts src/screens/Agents.tsx
git commit -m "feat(agents): wire Knowledge tab to KB upload/list/delete"
```

---

## Phase 2 — AI Auto-Reply

### Task 13: Schema — AiReply

**Files:** `backend/prisma/schema.prisma`

- [ ] **Step 1: Add AiReply model**

Append to `backend/prisma/schema.prisma`:

```prisma
model AiReply {
  id          String   @id @default(cuid())
  workspaceId String
  workspace   Workspace @relation("WorkspaceAiReplies", fields: [workspaceId], references: [id], onDelete: Cascade)

  conversationId String
  conversation   Conversation @relation("ConversationAiReplies", fields: [conversationId], references: [id], onDelete: Cascade)

  inboundMessageId String?
  inboundMessage   Message? @relation("AiReplyInbound", fields: [inboundMessageId], references: [id], onDelete: SetNull)

  outboundMessageId String?
  outboundMessage   Message? @relation("AiReplyOutbound", fields: [outboundMessageId], references: [id], onDelete: SetNull)

  action             String   // "reply" | "escalate"
  replyText          String?
  confidence         Float
  needsEscalation    Boolean
  escalationReason   String?
  usedKnowledge      Boolean
  missingInformation String?

  modelName        String
  promptTokens     Int?
  completionTokens Int?

  // JSON-encoded array of {chunkId, similarity} for traceability.
  sources String?

  createdAt DateTime @default(now())

  @@index([workspaceId])
  @@index([conversationId])
}
```

- [ ] **Step 2: Add inverse relations**

In `model Workspace`, append: `aiReplies AiReply[] @relation("WorkspaceAiReplies")`
In `model Conversation`, append: `aiReplies AiReply[] @relation("ConversationAiReplies")`
In `model Message`, append:

```prisma
  aiReplyAsInbound  AiReply[] @relation("AiReplyInbound")
  aiReplyAsOutbound AiReply[] @relation("AiReplyOutbound")
```

- [ ] **Step 3: Migrate**

```bash
cd backend
npx prisma migrate dev --name add_ai_reply
```

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(schema): AiReply audit log"
```

---

### Task 14: AiReplyService — TDD prompt + structured output

**Files:** `backend/src/ai/ai-reply.service.ts`, `backend/src/ai/ai-reply.service.spec.ts`, `backend/src/ai/ai.module.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/ai/ai-reply.service.spec.ts`:

```typescript
import { AiReplyService, AiReplyResult } from "./ai-reply.service";

describe("AiReplyService.parseStructuredOutput", () => {
  const svc = new AiReplyService({} as never, {} as never, {} as never);

  it("parses a valid reply payload", () => {
    const raw = JSON.stringify({
      action: "reply",
      reply: "Delivery: 1-2 business days.",
      confidence: 0.92,
      needsEscalation: false,
      escalationReason: null,
      usedKnowledge: true,
      missingInformation: null,
    });
    const out = svc.parseStructuredOutput(raw);
    expect(out.action).toBe("reply");
    expect(out.confidence).toBe(0.92);
  });

  it("parses an escalate payload", () => {
    const raw = JSON.stringify({
      action: "escalate",
      reply: null,
      confidence: 0.4,
      needsEscalation: true,
      escalationReason: "no KB match",
      usedKnowledge: false,
      missingInformation: "delivery policy missing",
    });
    const out = svc.parseStructuredOutput(raw);
    expect(out.action).toBe("escalate");
    expect(out.needsEscalation).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => svc.parseStructuredOutput("not json")).toThrow();
  });

  it("throws when confidence out of range", () => {
    const raw = JSON.stringify({
      action: "reply", reply: "x", confidence: 1.5,
      needsEscalation: false, escalationReason: null,
      usedKnowledge: true, missingInformation: null,
    });
    expect(() => svc.parseStructuredOutput(raw)).toThrow(/confidence/);
  });
});

describe("AiReplyService.shouldEscalate", () => {
  const svc = new AiReplyService({} as never, {} as never, {} as never);

  const base: AiReplyResult = {
    action: "reply",
    reply: "ok",
    confidence: 0.9,
    needsEscalation: false,
    escalationReason: null,
    usedKnowledge: true,
    missingInformation: null,
  };

  it("escalates when needsEscalation=true", () => {
    expect(svc.shouldEscalate({ ...base, needsEscalation: true }, 0.75)).toBe(true);
  });
  it("escalates when action=escalate", () => {
    expect(svc.shouldEscalate({ ...base, action: "escalate" }, 0.75)).toBe(true);
  });
  it("escalates when confidence below threshold", () => {
    expect(svc.shouldEscalate({ ...base, confidence: 0.6 }, 0.75)).toBe(true);
  });
  it("escalates when reply is empty", () => {
    expect(svc.shouldEscalate({ ...base, reply: "" }, 0.75)).toBe(true);
  });
  it("does not escalate on confident, non-empty reply", () => {
    expect(svc.shouldEscalate(base, 0.75)).toBe(false);
  });
});

describe("AiReplyService.buildSystemPrompt", () => {
  const svc = new AiReplyService({} as never, {} as never, {} as never);

  it("includes retrieved chunks as numbered KB items", () => {
    const prompt = svc.buildSystemPrompt([
      { chunkId: "c1", documentId: "d1", documentFilename: "faq.pdf", content: "Delivery: 1-2 days", similarity: 0.9 },
      { chunkId: "c2", documentId: "d1", documentFilename: "faq.pdf", content: "Refund: 30 days", similarity: 0.7 },
    ]);
    expect(prompt).toContain("[KB 1]");
    expect(prompt).toContain("Delivery: 1-2 days");
    expect(prompt).toContain("[KB 2]");
    expect(prompt).toContain("Refund: 30 days");
  });

  it("notes the empty-KB case", () => {
    const prompt = svc.buildSystemPrompt([]);
    expect(prompt.toLowerCase()).toContain("no knowledge");
  });
});
```

- [ ] **Step 2: Run to see failure**

```bash
cd backend
npm test -- ai-reply
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `backend/src/ai/ai-reply.service.ts`:

```typescript
import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiService } from "../openai/openai.service";
import {
  KnowledgeSearchService,
  KnowledgeSearchHit,
} from "../knowledge/knowledge-search.service";

export interface AiReplyResult {
  action: "reply" | "escalate";
  reply: string | null;
  confidence: number;
  needsEscalation: boolean;
  escalationReason: string | null;
  usedKnowledge: boolean;
  missingInformation: string | null;
}

export interface AiReplyContext {
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  inboundText: string;
  contactName?: string;
}

export interface AiReplyOutcome extends AiReplyResult {
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  sources: Array<{ chunkId: string; similarity: number }>;
}

const REPLY_JSON_SCHEMA = {
  name: "tkana_reply",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action:             { type: "string", enum: ["reply", "escalate"] },
      reply:              { type: ["string", "null"] },
      confidence:         { type: "number" },
      needsEscalation:    { type: "boolean" },
      escalationReason:   { type: ["string", "null"] },
      usedKnowledge:      { type: "boolean" },
      missingInformation: { type: ["string", "null"] },
    },
    required: [
      "action", "reply", "confidence", "needsEscalation",
      "escalationReason", "usedKnowledge", "missingInformation",
    ],
  },
} as const;

@Injectable()
export class AiReplyService {
  private readonly log = new Logger(AiReplyService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
    private readonly search: KnowledgeSearchService,
  ) {}

  parseStructuredOutput(raw: string): AiReplyResult {
    const obj = JSON.parse(raw);
    if (obj.action !== "reply" && obj.action !== "escalate") {
      throw new Error(`invalid action: ${obj.action}`);
    }
    if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
      throw new Error(`confidence out of range: ${obj.confidence}`);
    }
    return {
      action: obj.action,
      reply: obj.reply ?? null,
      confidence: obj.confidence,
      needsEscalation: !!obj.needsEscalation,
      escalationReason: obj.escalationReason ?? null,
      usedKnowledge: !!obj.usedKnowledge,
      missingInformation: obj.missingInformation ?? null,
    };
  }

  shouldEscalate(result: AiReplyResult, threshold: number): boolean {
    if (result.needsEscalation) return true;
    if (result.action === "escalate") return true;
    if (result.confidence < threshold) return true;
    if (!result.reply || !result.reply.trim()) return true;
    return false;
  }

  buildSystemPrompt(hits: KnowledgeSearchHit[]): string {
    const kbBlock = hits.length === 0
      ? "(no knowledge-base content available for this query)"
      : hits
          .map((h, i) => `[KB ${i + 1}] (from "${h.documentFilename}", similarity=${h.similarity.toFixed(2)})\n${h.content}`)
          .join("\n\n");

    return `You are a customer-support assistant replying on WhatsApp on behalf of a business.

Rules:
- Reply ONLY using facts present in the knowledge-base excerpts below. Do NOT invent.
- If the answer is not clearly present, set action="escalate" and explain in escalationReason.
- Keep replies short (1-3 sentences), friendly, in the same language as the customer (Arabic or English).
- Confidence is your honest 0.0-1.0 estimate that the reply is correct and complete given the excerpts.
- If the customer asks to speak to a human, set action="escalate", escalationReason="customer requested human".
- If the message expresses anger, complaint, or threats, set action="escalate", escalationReason="negative sentiment".

Knowledge base excerpts:
${kbBlock}`;
  }

  async generate(ctx: AiReplyContext): Promise<AiReplyOutcome> {
    const hits = await this.search.search(ctx.workspaceId, ctx.inboundText, 5);
    const systemPrompt = this.buildSystemPrompt(hits);

    const userMsg = ctx.contactName
      ? `Customer "${ctx.contactName}" wrote on WhatsApp: ${ctx.inboundText}`
      : `Customer wrote on WhatsApp: ${ctx.inboundText}`;

    const response = await this.openai.client.responses.create({
      model: this.openai.replyModel,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      text: { format: { type: "json_schema", ...REPLY_JSON_SCHEMA } },
    });

    const raw = (response as { output_text?: string }).output_text;
    if (!raw) throw new Error("openai response had no output_text");

    const parsed = this.parseStructuredOutput(raw);
    const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;

    return {
      ...parsed,
      modelName: this.openai.replyModel,
      promptTokens: usage?.input_tokens,
      completionTokens: usage?.output_tokens,
      sources: hits.map((h) => ({ chunkId: h.chunkId, similarity: h.similarity })),
    };
  }
}
```

- [ ] **Step 4: Create module**

Create `backend/src/ai/ai.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { AiReplyService } from "./ai-reply.service";

@Module({
  imports: [PrismaModule, KnowledgeModule],
  providers: [AiReplyService],
  exports: [AiReplyService],
})
export class AiModule {}
```

- [ ] **Step 5: Register in AppModule**

Add `AiModule` to `backend/src/app.module.ts` imports.

- [ ] **Step 6: Tests pass**

```bash
cd backend
npm test
```

Expected: all tests pass (chunker + ai-reply).

- [ ] **Step 7: Commit**

```bash
git add backend/src/ai backend/src/app.module.ts
git commit -m "feat(ai): structured-output reply service with KB retrieval"
```

---

### Task 15: Wire AI reply into WhatsApp ingest

**Files:** `backend/src/integrations/whatsapp.service.ts`, `backend/src/integrations/integrations.module.ts`

- [ ] **Step 1: Inject AiReplyService**

Edit the constructor of `WhatsAppService` (around line 96 of `whatsapp.service.ts`):

```typescript
import { AiReplyService } from "../ai/ai-reply.service";
// ...
@Injectable()
export class WhatsAppService {
  private readonly log = new Logger(WhatsAppService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiReply: AiReplyService,
  ) {}
```

- [ ] **Step 2: Import AiModule into IntegrationsModule**

Edit `backend/src/integrations/integrations.module.ts`:

```typescript
import { AiModule } from "../ai/ai.module";
// ...
@Module({
  imports: [/* existing */, AiModule],
  // ...
})
```

- [ ] **Step 3: Extend `ingestInbound` and add `maybeAutoReply`**

In `backend/src/integrations/whatsapp.service.ts`, find `private async ingestInbound(...)` (around line 527). At the END of that method (after the final `prisma.message.create`), capture the inbound row id and call the AI pipeline. Replace the final `prisma.message.create` block with:

```typescript
    const inboundRow = await this.prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        from: "them",
        body: body || `[${msg.type} message]`,
        t,
      },
    });

    if (body) {
      try {
        await this.maybeAutoReply({
          workspaceId,
          conversationId: conv.id,
          contactName: contact.name,
          waId,
          inboundMessageId: inboundRow.id,
          inboundText: body,
        });
      } catch (e) {
        this.log.warn(`AI auto-reply failed for conv=${conv.id}: ${(e as Error).message}`);
      }
    }
  }

  private async maybeAutoReply(ctx: {
    workspaceId: string;
    conversationId: string;
    contactName: string;
    waId: string;
    inboundMessageId: string;
    inboundText: string;
  }) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { aiAutoReplyEnabled: true, aiConfidenceThreshold: true },
    });
    if (!ws?.aiAutoReplyEnabled) return;

    const outcome = await this.aiReply.generate({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      inboundMessageId: ctx.inboundMessageId,
      inboundText: ctx.inboundText,
      contactName: ctx.contactName,
    });

    const threshold = ws.aiConfidenceThreshold ??
      Number(process.env.AI_REPLY_CONFIDENCE_THRESHOLD ?? 0.75);
    const escalate = this.aiReply.shouldEscalate(outcome, threshold);

    if (escalate) {
      await this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: {
          escalated: true,
          status: "human",
          intent: outcome.escalationReason ?? "ai-escalated",
          confidence: outcome.confidence,
        },
      });
      await this.prisma.aiReply.create({
        data: {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          inboundMessageId: ctx.inboundMessageId,
          outboundMessageId: null,
          action: "escalate",
          replyText: null,
          confidence: outcome.confidence,
          needsEscalation: true,
          escalationReason: outcome.escalationReason,
          usedKnowledge: outcome.usedKnowledge,
          missingInformation: outcome.missingInformation,
          modelName: outcome.modelName,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          sources: JSON.stringify(outcome.sources),
        },
      });
      return;
    }

    // Send via Meta.
    const { token, phoneNumberId } = await this.requireToken(ctx.workspaceId);
    await this.graphPost<{ messages?: Array<{ id: string }> }>(
      `/${phoneNumberId}/messages`,
      token,
      {
        messaging_product: "whatsapp",
        to: ctx.waId,
        type: "text",
        text: { body: outcome.reply },
      },
    );

    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const outboundRow = await this.prisma.message.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        from: "ai",
        body: outcome.reply!,
        t,
        agent: "ai",
      },
    });
    await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: {
        lastAt: "now",
        lastFrom: "ai",
        preview: outcome.reply!.slice(0, 140),
        status: "ai",
        intent: "ai-reply",
        confidence: outcome.confidence,
      },
    });
    await this.prisma.aiReply.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        inboundMessageId: ctx.inboundMessageId,
        outboundMessageId: outboundRow.id,
        action: "reply",
        replyText: outcome.reply,
        confidence: outcome.confidence,
        needsEscalation: false,
        escalationReason: null,
        usedKnowledge: outcome.usedKnowledge,
        missingInformation: outcome.missingInformation,
        modelName: outcome.modelName,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        sources: JSON.stringify(outcome.sources),
      },
    });
  }
```

- [ ] **Step 4: Build**

```bash
cd backend
npm run build
```

Expected: clean.

- [ ] **Step 5: End-to-end manual test**

1. Upload a small PDF via the Knowledge tab (Task 12 round-trip).
2. Flip `aiAutoReplyEnabled = true` for your workspace in Prisma Studio: `npm run prisma:studio`.
3. Start backend (`npm run dev`) + ngrok at port 3001; make sure your Meta webhook config points at the ngrok URL.
4. Send a WhatsApp message answerable by your KB (e.g. "how long is delivery?") → expect AI reply within 15s, Inbox shows inbound + ai message, `AiReply` row has `action=reply`, `confidence >= 0.75`.
5. Send an un-answerable message ("why is the sky blue?") → expect no outbound, conversation flips `escalated=true, status=human`, `AiReply` row has `action=escalate`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/integrations/whatsapp.service.ts backend/src/integrations/integrations.module.ts
git commit -m "feat(whatsapp): AI auto-reply with KB retrieval + confidence-based escalation"
```

---

### Task 16: Frontend AI badge + auto-reply status

**Files:** `src/screens/Inbox.tsx`, `src/screens/Agents.tsx`

- [ ] **Step 1: AI badge on messages**

In `src/screens/Inbox.tsx`, find the message-rendering loop. For each message with `from === "ai"`, add a small badge next to the body:

```tsx
{m.from === "ai" && <span className="msg-badge ai">AI</span>}
```

- [ ] **Step 2: Auto-reply status indicator in Agents**

In `src/screens/Agents.tsx` (escalation tab or header), render a read-only status:

```tsx
<div className="ai-status">
  Auto-reply: {workspace.aiAutoReplyEnabled ? "ON" : "OFF"}
  <small> — toggle via Prisma Studio for MVP</small>
</div>
```

A real settings toggle endpoint can ship in Plan 2.

- [ ] **Step 3: Visual check**

Refresh Inbox after the Task 15 end-to-end run — the AI reply message should show the "AI" badge.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Inbox.tsx src/screens/Agents.tsx
git commit -m "feat(inbox): AI badge on auto-reply messages"
```

---

## Phase 3 — Verify & Ship

### Task 17: Verification checklist + PR

- [ ] **Backend builds cleanly:** `cd backend && npm run build` → exits 0
- [ ] **All tests pass:** `cd backend && npm test` → green
- [ ] **Frontend builds:** `npm run build` from repo root → exits 0
- [ ] **KB round-trip works:** upload PDF → status=ready, chunkCount > 0
- [ ] **Search returns relevant chunks:** test via tmp script or via an AI reply that quotes the KB
- [ ] **AI reply succeeds:** WhatsApp KB-answerable question → reply sent within 15s
- [ ] **Escalation works:** WhatsApp un-answerable question → escalated, no outbound
- [ ] **Threshold honored:** raise `AI_REPLY_CONFIDENCE_THRESHOLD` to 0.99 → same question now escalates
- [ ] **Auto-reply toggle works:** set `aiAutoReplyEnabled=false` → no AI reply on next message
- [ ] **No regressions in existing WhatsApp send:** manual Inbox send still works

- [ ] **Push + PR:**

```bash
git push -u origin feat/whatsapp-ai-mvp
gh pr create --title "feat(whatsapp): AI assistant MVP — KB (pgvector) + auto-reply + escalation" --body "$(cat <<'EOF'
## Summary
- Migrate from SQLite to Neon Postgres with pgvector extension
- Knowledge base: PDF/DOCX/TXT upload → parse → chunk → embed (OpenAI text-embedding-3-small) → pgvector HNSW index
- AI auto-reply: top-5 KB retrieval (cosine) → OpenAI Responses (gpt-4o-mini) with JSON-schema structured output → confidence check
- Low-confidence or out-of-KB → escalate to human (Conversation.escalated=true, status=human)
- AiReply audit table with source chunks

## Out of scope (follow-up plans)
- BullMQ + Redis async processing (Plan 2)
- Dedicated WorkflowRule engine + Escalation model (Plan 3)
- Sentry, S3/R2, delivery-status tracking, rate limits (Plan 4)

## Test plan
- [ ] Backend builds + tests pass
- [ ] Upload PDF in Agents → Knowledge
- [ ] WhatsApp KB-answerable question → AI reply received
- [ ] WhatsApp un-answerable question → conversation escalates
- [ ] aiAutoReplyEnabled=false disables auto-reply
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- ✅ WhatsApp ingestion — Task 1 commits existing work
- ✅ KB upload + parse + chunk + embed + pgvector — Tasks 6–10
- ✅ Top-K similarity retrieval — Task 11
- ✅ AI reply with structured output + KB context — Task 14
- ✅ Confidence threshold + escalation — Task 14 + 15
- ✅ Inbox AI badge — Task 16
- ⏭ Workflow rules engine — Plan 3 (basic complaint/human-request handled inline in system prompt)
- ⏭ 24h-window template gating — Plan 3
- ⏭ BullMQ async — Plan 2 (synchronous is fine for MVP — OpenAI ~3–10s, well under Meta's 20s ack)
- ⏭ Dedicated Escalation model — Plan 3 (Conversation.escalated boolean for now)

**Placeholder scan:** No TBDs, no "fill in details". Every code-touching step has its code. Auth guard / API client helper paths flagged with verification commands.

**Type consistency:** `AiReplyResult` defined in Task 14 used consistently in Task 15. `KnowledgeSearchHit` from Task 11 used in Task 14. `KnowledgeDocument` shape matches between schema, DTO, and frontend client.

**Known risks:**
- The embedding column being `Unsupported` means all KB chunk INSERTs and queries go through `$queryRawUnsafe`/`$executeRawUnsafe` — be careful about parameter binding (we use positional `$1..$N` everywhere, not string interpolation, so SQL injection is safe).
- HNSW index build is async on first-write; for the small dev volumes this is invisible. At scale watch out for `maintenance_work_mem` — irrelevant for MVP.
- Synchronous webhook → AI reply means a slow OpenAI response delays Meta's ack. Meta's tolerance is ~20s; if you see timeouts, that's the BullMQ trigger for Plan 2.

---

## Execution Handoff

Plan saved. Starting **inline execution** now (per user's "ok start"). Task 1 begins.
