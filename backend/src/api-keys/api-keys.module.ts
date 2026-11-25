import { Global, Module } from "@nestjs/common";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";

/**
 * SP-27 organization API keys. Global so AuthGuard (an APP_GUARD in
 * AuthModule) can authenticate `crm_` bearers without a module cycle; it
 * depends only on global modules (Prisma, permissions, audit).
 */
@Global()
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
