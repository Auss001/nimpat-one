import { Module } from '@nestjs/common';
import { ApartmentsModule } from '../apartments/apartments.module';
import { OrdersModule } from '../orders/orders.module';
import { ServicesModule } from '../services/services.module';
import { SpaModule } from '../spa/spa.module';
import { AdminCustomersController, AdminCustomersService } from './admin-customers.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({ imports: [OrdersModule, ApartmentsModule, SpaModule, ServicesModule], providers: [UsersService, AdminCustomersService], controllers: [UsersController, AdminCustomersController], exports: [UsersService] })
export class UsersModule {}
