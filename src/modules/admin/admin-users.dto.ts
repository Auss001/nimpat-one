import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoleCode, UserStatus, UserType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CreateStaffDto {
  @ApiProperty() @Transform(({ value }) => String(value).trim().toLowerCase()) @IsEmail() email: string;
  @ApiProperty() @IsString() @Length(1, 80) firstName: string;
  @ApiProperty() @IsString() @Length(1, 80) lastName: string;
  @ApiProperty({ example: 'NIM-00123' }) @IsString() @Length(2, 40) employeeNumber: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) jobTitle?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiProperty({ enum: RoleCode }) @IsEnum(RoleCode) role: RoleCode;
  @ApiPropertyOptional({ description: 'Required for division-scoped roles' }) @IsOptional() @IsUUID() divisionId?: string;
}

export class AssignRoleDto {
  @ApiProperty({ enum: RoleCode }) @IsEnum(RoleCode) role: RoleCode;
  @ApiPropertyOptional({ description: 'Required for division-scoped roles' }) @IsOptional() @IsUUID() divisionId?: string;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus }) @IsEnum(UserStatus) status: UserStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 300) reason?: string;
}

export class UserQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: UserType }) @IsOptional() @IsEnum(UserType) type?: UserType;
  @ApiPropertyOptional({ description: 'Search email / phone / name' }) @IsOptional() @IsString() q?: string;
}
