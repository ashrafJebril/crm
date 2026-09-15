import { Injectable } from "@nestjs/common";
import { ContactsService } from "../../contacts/contacts.service";
import { TicketsService } from "../../tickets/tickets.service";
import { UpdateDataConfig } from "../workflow-steps";
import { RunContext } from "../workflow-variables";

@Injectable()
export class UpdateDataExecutor {
  constructor(
    private readonly contacts: ContactsService,
    private readonly tickets: TicketsService,
  ) {}

  async execute(
    workspaceId: string,
    config: UpdateDataConfig,
    context: RunContext,
  ): Promise<Record<string, unknown>> {
    switch (config.operation) {
      case "add_tag":
      case "remove_tag": {
        const contactId = this.requireContactId(context);
        const contact = await this.contacts.get(workspaceId, contactId);
        const nextTags =
          config.operation === "add_tag"
            ? Array.from(new Set([...contact.tags, config.tag]))
            : contact.tags.filter((t: string) => t !== config.tag);
        await this.contacts.update(workspaceId, contactId, { tags: nextTags });
        return { tags: nextTags };
      }
      case "move_ticket_stage": {
        const ticketId = this.requireTicketId(context);
        const updated = await this.tickets.moveTicket(workspaceId, ticketId, { stageId: config.stageId });
        return { stageId: updated.stageId };
      }
      case "update_contact_field": {
        const contactId = this.requireContactId(context);
        await this.contacts.update(workspaceId, contactId, { [config.field]: config.value });
        return { [config.field]: config.value };
      }
    }
  }

  private requireContactId(context: RunContext): string {
    const contact = context.trigger.contact as { id?: string } | undefined;
    if (!contact?.id) throw new Error("Update CRM Data step needs a contact in the trigger context");
    return contact.id;
  }

  private requireTicketId(context: RunContext): string {
    const ticket = context.trigger.ticket as { id?: string } | undefined;
    if (!ticket?.id) throw new Error("Update CRM Data step needs a ticket in the trigger context");
    return ticket.id;
  }
}
