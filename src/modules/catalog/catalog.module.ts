import { Module } from '@nestjs/common';
import { AdminCatalogController, CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({ providers: [CatalogService], controllers: [CatalogController, AdminCatalogController], exports: [CatalogService] })
export class CatalogModule {}
