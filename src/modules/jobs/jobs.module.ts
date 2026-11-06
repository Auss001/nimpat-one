import {
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/app-config.service';
import { Public } from '../../common/decorators/auth.decorators';
import { ApartmentsModule } from '../apartments/apartments.module';
import { ApartmentsService } from '../apartments/apartments.service';
import { OrdersModule } from '../orders/orders.module';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';

import { QuotationsModule, QuotationsService } from '../quotations/quotations.module';
import { SpaModule, SpaService } from '../spa/spa.module';

/**
 * Housekeeping jobs: expire unpaid orders/holds and reconcile payments.
 * Locally they run on timers (JOBS_INPROCESS=true). On Cloud Run — where
 * instances may scale to zero — Cloud Scheduler calls POST /api/v1/internal/jobs/*
 * with the X-Job-Token header. Every job is idempotent and safe to overlap.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly orders: OrdersService,
    private readonly apartments: ApartmentsService,
    private readonly spa: SpaService,
    private readonly quotations: QuotationsService,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit() {
    if (!this.config.get('JOBS_INPROCESS') || process.env.NODE_ENV === 'test') return;
    this.timers.push(setInterval(() => void this.run('expire', () => this.expireAll()), 60_000));
    this.timers.push(setInterval(() => void this.run('reconcile', () => this.payments.reconcile()), 5 * 60_000));
    this.logger.log('In-process jobs enabled (expire: 1 min, reconcile: 5 min)');
  }

  onApplicationShutdown() {
    this.timers.forEach(clearInterval);
  }

  async expireAll() {
    const [orders, reservations, spaHolds] = await Promise.all([this.orders.expireStale(), this.apartments.expireHolds(), this.spa.expireHolds()]);
    await this.quotations.expireOverdue();
    if (orders || reservations || spaHolds) this.logger.log(`Expired orders=${orders} reservations=${reservations} spa=${spaHolds}`);
    return { expiredOrders: orders, expiredReservations: reservations, expiredSpaHolds: spaHolds };
  }

  async run<T>(name: string, fn: () => Promise<T>): Promise<T | { skipped: true }> {
    if (this.running.has(name)) return { skipped: true };
    this.running.add(name);
    try {
      return await fn();
    } catch (e) {
      this.logger.error(`Job ${name} failed: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running.delete(name);
    }
  }
}

@ApiExcludeController()
@SkipThrottle()
@Controller('internal/jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly payments: PaymentsService,
    private readonly config: AppConfig,
  ) {}

  @Public() @Post('expire') @HttpCode(200)
  expire(@Headers('x-job-token') token?: string) {
    this.authorize(token);
    return this.jobs.run('expire', () => this.jobs.expireAll());
  }

  @Public() @Post('reconcile-payments') @HttpCode(200)
  reconcile(@Headers('x-job-token') token?: string) {
    this.authorize(token);
    return this.jobs.run('reconcile', () => this.payments.reconcile());
  }

  private authorize(token?: string) {
    const expected = Buffer.from(this.config.get('JOBS_TOKEN'));
    const given = Buffer.from(token ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ForbiddenException();
  }
}

@Module({
  imports: [OrdersModule, ApartmentsModule, SpaModule, QuotationsModule],
  providers: [JobsService],
  controllers: [JobsController],
})
export class JobsModule {}
