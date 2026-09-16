import { Module } from "@nestjs/common";
import { ContactsModule } from "../contacts/contacts.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { TicketsModule } from "../tickets/tickets.module";
import { AskAgentExecutor } from "./executors/ask-agent.executor";
import { SendWhatsappExecutor } from "./executors/send-whatsapp.executor";
import { UpdateDataExecutor } from "./executors/update-data.executor";
import { WorkflowDispatchService } from "./workflow-dispatch.service";
import { WorkflowRunnerService } from "./workflow-runner.service";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";

@Module({
  imports: [IntegrationsModule, ContactsModule, TicketsModule],
  controllers: [WorkflowsController],
  providers: [
    WorkflowsService,
    WorkflowDispatchService,
    WorkflowRunnerService,
    SendWhatsappExecutor,
    AskAgentExecutor,
    UpdateDataExecutor,
  ],
  exports: [WorkflowDispatchService, WorkflowRunnerService],
})
export class WorkflowsModule {}
