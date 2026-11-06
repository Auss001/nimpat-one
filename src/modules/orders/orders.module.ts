import { Module } from '@nestjs/common';
import { AdminOrdersController, OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({ providers: [OrdersService], controllers: [OrdersController, AdminOrdersController], exports: [OrdersService] })
export class OrdersModule {}
