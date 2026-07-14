import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody:true keeps the exact request bytes on `req.rawBody` so the Meta
  // webhook guard can verify the X-Hub-Signature-256 HMAC (JSON is still
  // parsed normally for the handlers).
  const app = await NestFactory.create(AppModule, { cors: false, rawBody: true });

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173",
    credentials: true,
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
