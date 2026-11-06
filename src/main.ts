import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { API_PREFIX, buildOpenApi, configureApp } from './bootstrap';
import { AppConfig } from './config/app-config.service';

async function bootstrap() {
  // rawBody is required to verify Paystack webhook signatures byte-for-byte.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bufferLogs: true });
  configureApp(app);
  const config = app.get(AppConfig);

  // Interactive docs are disabled in production; the JSON spec stays available.
  const document = buildOpenApi(app);
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
    jsonDocumentUrl: `${API_PREFIX}/docs/openapi.json`,
    swaggerUiEnabled: !config.isProduction,
    swaggerOptions: { persistAuthorization: true },
  });

  // Cloud Run provides PORT and expects the server on 0.0.0.0.
  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  Logger.log(`Nimpat One API listening on :${port} (docs: /${API_PREFIX}/docs)`, 'Bootstrap');
}

void bootstrap();
