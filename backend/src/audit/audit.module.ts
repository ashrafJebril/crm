import { Global, Module } from "@nestjs/common";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";

/** SP-26: the workspace audit log. Global so any writer can record inside
 *  its own transaction (`AuditService.record(tx, …)`). */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
