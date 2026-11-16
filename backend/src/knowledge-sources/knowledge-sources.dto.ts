/**
 * SP-21 knowledge DTOs. Request bodies run through the global ValidationPipe
 * (`whitelist`, `forbidNonWhitelisted`): an unknown field is a 400. Length and
 * content rules live in the service so every refusal carries a knowledge key.
 */
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Min } from "class-validator";
import type { KnowledgeKind, KnowledgeStatus, PageState, Schedule, TypedKind } from "./knowledge-constants";
import { FAQ_MAX, KNOWLEDGE_KINDS, KNOWLEDGE_STATUSES, SCHEDULES, TYPED_KINDS } from "./knowledge-constants";

export class PutContentDto {
  @IsObject()
  bodyJson!: Record<string, unknown>;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class PutGuidelinesDto {
  @IsString()
  body!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class CreateFaqDto {
  @IsString()
  @IsNotEmpty()
  question!: string;

  @IsString()
  @IsNotEmpty()
  answer!: string;
}

export class PatchFaqDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  question?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  answer?: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class ReorderFaqsDto {
  @IsArray()
  @ArrayMaxSize(FAQ_MAX)
  @IsString({ each: true })
  ids!: string[];
}

/** Multipart fields next to `files[]` (strings on the wire). */
export class UploadFilesDto {
  @IsOptional()
  @IsIn(TYPED_KINDS as unknown as string[])
  typedKind?: TypedKind;

  @IsOptional()
  @IsIn(["true", "false", true, false])
  acceptValidRows?: string | boolean;
}

export class ListSourcesQuery {
  @IsOptional()
  @IsIn(KNOWLEDGE_KINDS as unknown as string[])
  kind?: KnowledgeKind;

  @IsOptional()
  @IsIn(KNOWLEDGE_STATUSES as unknown as string[])
  status?: KnowledgeStatus;
}

export class ListPagesQuery {
  @IsOptional()
  @IsString()
  state?: PageState;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export interface KnowledgeFileDto {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface KnowledgeSourceDto {
  id: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  error: string | null;
  title: string;
  body?: string | null;
  bodyJson?: unknown;
  question?: string | null;
  order: number;
  typedKind: TypedKind | null;
  url: string | null;
  scope: "site" | "path" | null;
  schedule: Schedule | null;
  lastSyncAt: Date | null;
  nextSyncAt: Date | null;
  /**
   * Websites: failed sync runs in a row (3 → `failed`). File and typed-doc
   * sources: transient provider retries used (0 or 1). The UI must not show
   * the website wording ("failed N times in a row") for files.
   */
  consecutiveFailures: number;
  lastRun: unknown;
  itemCount: number;
  publishState: string;
  legacy: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  file: KnowledgeFileDto | null;
  pageCounts?: Partial<Record<PageState, number>>;
}

export interface KnowledgePreviewItem {
  chunkId: string;
  text: string;
  rowRef: number | null;
  url: string | null;
}

export interface KnowledgePreviewDto {
  sourceId: string;
  groups: { heading: string | null; items: KnowledgePreviewItem[] }[];
  truncated: boolean;
}

export interface KnowledgePageDto {
  id: string;
  url: string;
  title: string | null;
  state: PageState;
  httpStatus: number | null;
  lastReadAt: Date | null;
  removedAt: Date | null;
}

// ── SP-21 Task 2: websites ──────────────────────────────────────────────

export class CheckWebsiteDto {
  @IsString()
  @IsNotEmpty()
  url!: string;
}

export class CreateWebsiteDto {
  @IsString()
  @IsNotEmpty()
  url!: string;

  @IsOptional()
  @IsIn(["site", "path"])
  scope?: "site" | "path";

  @IsOptional()
  @IsIn(SCHEDULES as unknown as string[])
  schedule?: Schedule;
}

export class PatchWebsiteDto {
  @IsOptional()
  @IsIn(SCHEDULES as unknown as string[])
  schedule?: Schedule;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}
