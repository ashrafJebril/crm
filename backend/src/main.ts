import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AppModule } from "./app.module";
import { configureBodyParsers } from "./common/body-parsers";

async function bootstrap() {
  // rawBody:true keeps the exact request bytes on `req.rawBody` so the Meta
  // webhook guard can verify the X-Hub-Signature-256 HMAC (JSON is still
  // parsed normally for the handlers).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false, rawBody: true });
  // 2mb JSON for select-all bulk bodies; keeps the rawBody hook (see helper).
  configureBodyParsers(app);

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173",
    credentials: true,
    // SP-13: the media library's next-page cursor (GET /media).
    exposedHeaders: ["X-Media-Next-Before"],
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.PORT) || 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`tkana backend listening on http://localhost:${port}/api`);
}

bootstrap();
