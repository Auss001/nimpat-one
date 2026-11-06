import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Query errors are thrown to callers (and mapped/logged by the exception
    // filter), so only engine warnings are logged here. Expected constraint
    // violations — e.g. a rejected double booking — are not noise in the logs.
    super({ log: [{ emit: 'event', level: 'warn' }] });
  }

  async onModuleInit(): Promise<void> {
    // Connect lazily on first query; an eager connect makes Cloud Run cold
    // starts fail hard when the DB is briefly unavailable.
    (this as any).$on('warn', (e: Prisma.LogEvent) => this.logger.warn(e.message));
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
