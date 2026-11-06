import { Global, Module } from '@nestjs/common';
import { AdminDeliveryController, DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';

@Global()
@Module({ providers: [DeliveryService], controllers: [DeliveryController, AdminDeliveryController], exports: [DeliveryService] })
export class DeliveryModule {}
