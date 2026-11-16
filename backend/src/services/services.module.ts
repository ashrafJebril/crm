import { Module } from "@nestjs/common";
import { ServicesController } from "./services.controller";
import { ServicesService } from "./services.service";

/** SP-10: the bookings services catalog. */
@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
