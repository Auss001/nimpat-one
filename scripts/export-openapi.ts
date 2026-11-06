/**
 * Writes the versioned OpenAPI 3 document to docs/openapi/ without starting a server
 * or connecting to the database. Useful for the web/mobile teams to generate
 * typed API clients:  npm run openapi:export
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

// Placeholder config: only needed to satisfy env validation, nothing connects.
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'openapi-export-placeholder-secret-0000000000',
  JOBS_TOKEN: process.env.JOBS_TOKEN ?? 'openapi-export-placeholder',
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY ?? 'sk_test_openapi_export_placeholder',
  JOBS_INPROCESS: 'false',
});

async function main() {
  const { AppModule } = await import('../src/app.module');
  const { buildOpenApi, configureApp } = await import('../src/bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.init();
  const doc = buildOpenApi(app);
  mkdirSync('docs/openapi', { recursive: true });
  writeFileSync('docs/openapi/nimpat-one-api.v1.json', JSON.stringify(doc, null, 2));
  console.log(`docs/openapi/nimpat-one-api.v1.json written: ${Object.keys(doc.paths).length} paths`);
  await app.close();
}

void main();
