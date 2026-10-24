import { Global, Module } from "@nestjs/common";
import { KewyIdentityClient } from "./kewy-identity.client";
import { KewyIdentitySync } from "./kewy-identity.sync";

/** Kewy identity API client + dual-write helper, available everywhere. */
@Global()
@Module({
  providers: [KewyIdentityClient, KewyIdentitySync],
  exports: [KewyIdentityClient, KewyIdentitySync],
})
export class KewyIdentityModule {}
