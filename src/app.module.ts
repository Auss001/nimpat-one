import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/prisma-exception.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { requestContextMiddleware } from './common/request-context';
import { AppConfig } from './config/app-config.service';
import { validateEnv } from './config/env.validation';
import { AccessModule } from './modules/access/access.module';
import { AdminModule } from './modules/admin/admin.module';
import { ApartmentsModule } from './modules/apartments/apartments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CartModule } from './modules/cart/cart.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { DivisionsModule } from './modules/divisions/divisions.module';
import { HealthController } from './modules/health/health.controller';
import { InventoryModule } from './modules/inventory/inventory.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { QuotationsModule } from './modules/quotations/quotations.module';
import { RecordsModule } from './modules/records/records.module';
import { ReportsModule } from './modules/reports/reports.module';
import { ServicesModule } from './modules/services/services.module';
import { PhotosModule } from './modules/photos/photos.module';
import { SpaModule } from './modules/spa/spa.module';
import { UsersModule } from './modules/users/users.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { HomeSlidesModule } from './modules/home-slides/home-slides.module';
import { PrismaModule } from './prisma/prisma.module';

@Global()
@Module({ providers: [AppConfig], exports: [AppConfig] })
class AppConfigModule {}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    AppConfigModule,
    JwtModule.registerAsync({
      global: true,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        secret: config.get('JWT_ACCESS_SECRET'),
        signOptions: { issuer: 'nimpat-one', audience: 'nimpat-one-api', algorithm: 'HS256' },
        verifyOptions: { issuer: 'nimpat-one', audience: 'nimpat-one-api', algorithms: ['HS256'] },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        throttlers: [{ name: 'default', ttl: config.get('RATE_LIMIT_TTL_SECONDS') * 1000, limit: config.get('RATE_LIMIT_MAX') }],
      }),
    }),
    PrismaModule,
    AccessModule,
    AuditModule,
    NotificationsModule,
    DivisionsModule,
    AuthModule,
    UsersModule,
    AdminModule,
    // Commerce (Water, Drinks & Wines first; reusable by Retail & Media rentals)
    CatalogModule,
    InventoryModule,
    DeliveryModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    LoyaltyModule,
    // Bookings & services
    ApartmentsModule,
    VehiclesModule,
    ServicesModule,
    SpaModule,
    PhotosModule,
    HomeSlidesModule,
    LogisticsModule,
    QuotationsModule,
    // Operations
    ReportsModule,
    RecordsModule,
    JobsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*path');
  }
}
