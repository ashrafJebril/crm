import { Module } from "@nestjs/common";
import { ContactsModule } from "../contacts/contacts.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { TicketsModule } from "../tickets/tickets.module";
import { AskAgentExecutor } from "./executors/ask-agent.executor";
import { SendWhatsappExecutor } from "./executors/send-whatsapp.executor";
import { UpdateDataExecutor } from "./executors/update-data.executor";
import { WorkflowDispatchService } from "./workflow-dispatch.service";
import { WorkflowRunPollerScheduler } from "./workflow-run-poller.scheduler";
import { WorkflowRunnerService } from "./workflow-runner.service";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";
import { WorkflowsWebhookController } from "./workflows-webhook.controller";
import { WorkflowWebhookSignatureGuard } from "./workflow-webhook-signature.guard";

@Module({
  imports: [IntegrationsModule, ContactsModule, TicketsModule],
  controllers: [WorkflowsController, WorkflowsWebhookController],
  providers: [
    WorkflowsService,
    WorkflowDispatchService,
    WorkflowRunnerService,
    WorkflowRunPollerScheduler,
    WorkflowWebhookSignatureGuard,
    SendWhatsappExecutor,
    AskAgentExecutor,
    UpdateDataExecutor,
  ],
  exports: [WorkflowDispatchService, WorkflowRunnerService],
})
export class WorkflowsModule {}
