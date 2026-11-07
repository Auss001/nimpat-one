import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/auth.decorators';
import { DivisionsService } from './divisions.service';

@ApiTags('Divisions')
@Controller('divisions')
export class DivisionsController {
  constructor(private readonly divisions: DivisionsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List Nimpat Group business divisions available in Nimpat One' })
  list() {
    return this.divisions.listPublic();
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get a division by slug or code' })
  async get(@Param('slug') slug: string) {
    const d = await this.divisions.resolve(slug);
    return { id: d.id, code: d.code, name: d.name, slug: d.slug, kind: d.kind, description: d.description, hideOutOfStock: d.hideOutOfStock };
  }
}
