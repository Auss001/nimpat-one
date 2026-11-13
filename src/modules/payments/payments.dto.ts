import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  CollectionPoint,
  ConfirmationRule,
  DepositType,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  ReconciliationStatus,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { MinorAmount } from '../catalog/catalog.dto';

const AMOUNT_OPTIONS = ['BALANCE', 'DEPOSIT', 'FULL'] as const;

export class PayableRefDto {
  @ApiProperty({ enum: PaymentPurpose, example: PaymentPurpose.ORDER }) @IsEnum(PaymentPurpose) purpose: PaymentPurpose;
  @ApiProperty({ description: 'Id of the order / reservation / booking being paid for' }) @IsUUID() payableId: string;
}

export class InitializePaymentDto extends PayableRefDto {
  @ApiPropertyOptional({ enum: AMOUNT_OPTIONS, default: 'BALANCE', description: 'BALANCE = everything still owed; DEPOSIT = only the required deposit' })
  @IsOptional() @IsIn(AMOUNT_OPTIONS) amountOption?: (typeof AMOUNT_OPTIONS)[number];
  @ApiPropertyOptional({ enum: ['web', 'app'], default: 'web', description: 'app = the phone apps: after paying, Paystack shows a plain "back to the app" page instead of the website' })
  @IsOptional() @IsIn(['web', 'app']) returnTo?: 'web' | 'app';
}

export class PayableQueryDto {
  @ApiProperty({ enum: PaymentPurpose }) @IsEnum(PaymentPurpose) purpose: PaymentPurpose;
  @ApiProperty() @IsUUID() payableId: string;
}

export class MethodsQueryDto {
  @ApiProperty({ example: 'water-drinks-wines' }) @IsString() division: string;
  @ApiProperty({ enum: PaymentPurpose }) @IsEnum(PaymentPurpose) purpose: PaymentPurpose;
}

export class TransferNoticeDto {
  @ApiProperty({ example: 'Ada Okafor' }) @IsString() @Length(2, 120) payerName: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() transferredAt?: string;
  @ApiPropertyOptional({ description: 'Amount the customer says they sent (kobo). Verification uses the bank record, not this.' })
  @IsOptional() @MinorAmount() @IsInt() @Min(1) amountMinor?: number;
  @ApiPropertyOptional({ description: 'Bank session ID / reference shown on the customer’s receipt' })
  @IsOptional() @IsString() @Length(2, 120) customerReference?: string;
}

export class RecordCollectionDto extends PayableRefDto {
  @ApiProperty({ enum: [PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER, PaymentMethod.CARD_TERMINAL] })
  @IsIn([PaymentMethod.CASH, PaymentMethod.BANK_TRANSFER, PaymentMethod.CARD_TERMINAL]) method: PaymentMethod;
  @ApiProperty({ enum: ['DELIVERY', 'SERVICE_LOCATION'] }) @IsIn(['DELIVERY', 'SERVICE_LOCATION']) point: 'DELIVERY' | 'SERVICE_LOCATION';
  @ApiPropertyOptional({ description: 'Required for SERVICE_LOCATION' }) @ValidateIf((o) => o.point === 'SERVICE_LOCATION') @IsUUID() serviceLocationId?: string;
  @ApiProperty({ description: 'Amount collected in kobo' }) @MinorAmount() @IsInt() @Min(1) amountMinor: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() collectedAt?: string;
  @ApiPropertyOptional({ description: 'Customer transfer reference, terminal slip number…' }) @IsOptional() @IsString() @Length(1, 120) collectionReference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) note?: string;
}

export class ConfirmFundsDto {
  @ApiProperty({ description: 'Amount actually received, from the trusted record (kobo)' }) @MinorAmount() @IsInt() @Min(1) receivedAmountMinor: number;
  @ApiProperty({ description: 'Bank statement line / cash book reference. Bank references can be used once.' }) @IsString() @Length(3, 120) verificationReference: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() receivedAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) note?: string;
}

export class ReasonDto {
  @ApiProperty() @IsString() @Length(3, 500) reason: string;
}

export class NoteDto {
  @ApiProperty() @IsString() @Length(3, 500) note: string;
}

export class ReconcileDto {
  @ApiProperty({ description: 'Bank settlement / banking-slip reference' }) @IsString() @Length(3, 120) settlementReference: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 500) note?: string;
}

export class RefundDto {
  @ApiPropertyOptional({ description: 'Amount in kobo; omit for a full refund' }) @IsOptional() @MinorAmount() @IsInt() @Min(1) amountMinor?: number;
  @ApiProperty() @IsString() @Length(3, 300) reason: string;
}

export class AdminPaymentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus }) @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;
  @ApiPropertyOptional({ enum: PaymentPurpose }) @IsOptional() @IsEnum(PaymentPurpose) purpose?: PaymentPurpose;
  @ApiPropertyOptional({ enum: PaymentMethod }) @IsOptional() @IsEnum(PaymentMethod) method?: PaymentMethod;
  @ApiPropertyOptional({ enum: CollectionPoint }) @IsOptional() @IsEnum(CollectionPoint) collectionPoint?: CollectionPoint;
  @ApiPropertyOptional({ enum: ReconciliationStatus }) @IsOptional() @IsEnum(ReconciliationStatus) reconciliationStatus?: ReconciliationStatus;
  @ApiPropertyOptional({ description: 'Division id, slug or code' }) @IsOptional() @IsString() division?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() serviceLocationId?: string;
  @ApiPropertyOptional({ description: 'Staff member who reported the collection' }) @IsOptional() @IsUUID() reportedById?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

export class FinanceQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() division?: string;
  @ApiPropertyOptional({ enum: PaymentPurpose }) @IsOptional() @IsEnum(PaymentPurpose) purpose?: PaymentPurpose;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class BankAccountDto {
  @ApiPropertyOptional({ description: 'Division slug/code; omit for the group-wide default account' }) @IsOptional() @IsString() division?: string;
  @ApiProperty({ example: 'Water, Drinks & Wines collections' }) @Transform(trim) @IsString() @Length(2, 80) label: string;
  @ApiProperty({ example: 'Example Bank Plc' }) @Transform(trim) @IsString() @Length(2, 80) bankName: string;
  @ApiProperty({ example: 'Nimpat Group Ltd' }) @Transform(trim) @IsString() @Length(2, 120) accountName: string;
  @ApiProperty({ example: '0123456789', description: '10-digit NUBAN' }) @Matches(/^\d{10}$/, { message: 'accountNumber must be a 10-digit NUBAN' }) accountNumber: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateBankAccountDto extends PartialType(BankAccountDto) {}

export class ServiceLocationDto {
  @ApiProperty({ example: 'spa-wellness' }) @IsString() division: string;
  @ApiProperty({ example: 'SPA-WUYE' }) @Matches(/^[A-Z0-9][A-Z0-9-]{2,39}$/) code: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(2, 120) name: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(3, 200) addressLine: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(2, 80) city: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(2, 40) state: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptsCash?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() acceptsBankTransfer?: boolean;
  @ApiPropertyOptional({ description: 'Card terminal payments are recorded manually; no terminal integration exists' }) @IsOptional() @IsBoolean() acceptsCardTerminal?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateServiceLocationDto extends PartialType(ServiceLocationDto) {}

export class PaymentPolicyDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowPaystack?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowBankTransfer?: boolean;
  @ApiPropertyOptional({ description: 'Product orders only' }) @IsOptional() @IsBoolean() allowPayOnDelivery?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowPayAtLocation?: boolean;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @MinorAmount() @IsInt() @Min(0) payOnDeliveryMinOrderMinor?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @MinorAmount() @IsInt() @Min(1) payOnDeliveryMaxOrderMinor?: number | null;
  @ApiPropertyOptional({ enum: DepositType }) @IsOptional() @IsEnum(DepositType) depositType?: DepositType;
  @ApiPropertyOptional({ description: 'Basis points: 3000 = 30%', nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(10000) depositPercentBps?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @MinorAmount() @IsInt() @Min(1) depositFixedMinor?: number | null;
  @ApiPropertyOptional({ enum: ConfirmationRule }) @IsOptional() @IsEnum(ConfirmationRule) confirmationRule?: ConfirmationRule;
  @ApiPropertyOptional({ minimum: 1, maximum: 336 }) @IsOptional() @IsInt() @Min(1) @Max(336) bankTransferWindowHours?: number;
}
