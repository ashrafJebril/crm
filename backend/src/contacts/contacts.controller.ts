import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ContactsService } from "./contacts.service";
import { CreateContactDto, UpdateContactDto } from "./contacts.dto";

@Controller("contacts")
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get() list() { return this.contacts.list(); }
  @Get(":id") get(@Param("id") id: string) { return this.contacts.get(id); }
  @Post() create(@Body() dto: CreateContactDto) { return this.contacts.create(dto); }
  @Patch(":id") update(@Param("id") id: string, @Body() dto: UpdateContactDto) {
    return this.contacts.update(id, dto);
  }
  @Delete(":id") remove(@Param("id") id: string) { return this.contacts.remove(id); }
}
