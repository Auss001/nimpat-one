import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { join } from 'node:path';
import { AppConfig } from './config/app-config.service';

// JSON has no BigInt. Money columns are BigInt minor units; they serialise
// as plain integers (always far below 2^53 for realistic amounts).
(BigInt.prototype as unknown as { toJSON: () => number | string }).toJSON = function (this: bigint) {
  return this <= BigInt(Number.MAX_SAFE_INTEGER) && this >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(this) : this.toString();
};

export const API_PREFIX = 'api';

/** Shared app setup for main.ts, e2e tests and the OpenAPI export script. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);

  if (config.get('TRUST_PROXY')) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Swagger UI needs inline scripts/styles; everything else is JSON.
      contentSecurityPolicy: config.isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.useBodyParser('json', { limit: '1mb' });

  // Catalogue photos shipped with the API (until Cloud Storage uploads exist).
  app.useStaticAssets(join(process.cwd(), 'media'), { prefix: '/media', maxAge: '7d', index: false, dotfiles: 'deny' });

  app.setGlobalPrefix(API_PREFIX, { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const doc = new DocumentBuilder()
    .setTitle('Nimpat One API')
    .setDescription(
      [
        'Central REST API for Nimpat One — Nimpat Group of Companies, Nigeria.',
        '',
        '**Money** is always an integer in minor units (kobo): `150000` = ₦1,500.00.',
        '**Auth**: send `Authorization: Bearer <accessToken>`. Refresh with `/auth/refresh`.',
        '**Idempotency**: checkout, booking and payment-initialisation endpoints accept an `Idempotency-Key` header.',
        '**Payments** run in Paystack test mode only.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addServer('/', 'This server')
    .build();
  return SwaggerModule.createDocument(app, doc, { operationIdFactory: (controller, method) => `${controller.replace(/Controller$/, '')}_${method}` });
}
