import { Module } from "@nestjs/common";
import { AnthropicCatalogExtractor, CATALOG_EXTRACTOR } from "./anthropic-extractor";
import { CatalogImportController } from "./catalog-import.controller";
import { CatalogImportService } from "./catalog-import.service";
import { CatalogImportRunner } from "./catalog-import.runner";
import { CatalogImportResumeScheduler } from "./catalog-import-resume.scheduler";

/** SP-10: catalog import (paste, website, file; AI extraction; review; resumable run). */
@Module({
  controllers: [CatalogImportController],
  providers: [
    CatalogImportService,
    CatalogImportRunner,
    CatalogImportResumeScheduler,
    { provide: CATALOG_EXTRACTOR, useFactory: () => new AnthropicCatalogExtractor() },
  ],
})
export class CatalogImportModule {}
