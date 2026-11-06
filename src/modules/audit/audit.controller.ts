import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional({ description: 'Prefix match, e.g. "auth." or "product."' }) @IsOptional() @IsString() action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityId?: string;
}

@ApiTags('Admin · Audit')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(P.auditRead)
  @ApiOperation({ summary: 'Search the audit trail' })
  search(@Query() q: AuditQueryDto, @CurrentUser() user: AuthUser) {
    return this.audit.search(q, user.divisionFilter(P.auditRead));
  }
}
