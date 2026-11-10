import { Module } from '@nestjs/common';
import { AdminCatalogController, CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PriceListService } from './price-list.service';

@Module({ providers: [CatalogService, PriceListService], controllers: [CatalogController, AdminCatalogController], exports: [CatalogService] })
export class CatalogModule {}
