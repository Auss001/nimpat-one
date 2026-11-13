import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiExcludeEndpoint, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentPurpose } from '@prisma/client';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Authenticated, CurrentUser, Public, RequirePermissions } from '../../common/decorators/auth.decorators';
import { IdempotencyKey } from '../../common/decorators/idempotency-key.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AuthUser } from '../access/auth-user';
import { P } from '../access/permissions';
import { ManualPaymentsService } from './manual-payments.service';
import {
  AdminPaymentQueryDto,
  BankAccountDto,
  ConfirmFundsDto,
  FinanceQueryDto,
  InitializePaymentDto,
  MethodsQueryDto,
  NoteDto,
  PayableQueryDto,
  PaymentPolicyDto,
  ReasonDto,
  ReconcileDto,
  RecordCollectionDto,
  RefundDto,
  ServiceLocationDto,
  TransferNoticeDto,
  UpdateBankAccountDto,
  UpdateServiceLocationDto,
} from './payments.dto';
import { PaymentSettingsService } from './payment-settings.service';
import { PaymentsService } from './payments.service';
import { MAX_PROOF_BYTES } from './proof-storage.service';

const REFERENCE = /^[A-Za-z0-9.=-]{6,100}$/;
const checkRef = (r: string) => {
  if (!REFERENCE.test(r)) throw new BadRequestException('Invalid reference');
  return r;
};

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly manual: ManualPaymentsService,
    private readonly settings: PaymentSettingsService,
  ) {}

  @Public()
  @Get('methods')
  @ApiOperation({ summary: 'How a division accepts payment for a transaction type (for showing payment options)' })
  methods(@Query() q: MethodsQueryDto) {
    return this.settings.publicMethods(q.division, q.purpose);
  }

  @Authenticated()
  @Get('options')
  @ApiOperation({ summary: 'Payment options, deposit and balance for one of my orders / bookings' })
  options(@CurrentUser() user: AuthUser, @Query() q: PayableQueryDto) {
    return this.manual.optionsForPayable(user, q.purpose, q.payableId);
  }

  @Authenticated()
  @Get('summary')
  @ApiOperation({ summary: 'What is owed, paid, awaiting verification and outstanding, with payment history' })
  summary(@CurrentUser() user: AuthUser, @Query() q: PayableQueryDto) {
    return this.payments.customerSummary(user, q.purpose, q.payableId);
  }

  @Authenticated()
  @Post('initialize')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Start a Paystack (test mode) checkout — card, Paystack bank transfer or USSD',
    description: 'The amount is computed on the server (balance or deposit). Redirect to authorizationUrl or use accessCode with Paystack Popup.',
  })
  initialize(@CurrentUser() user: AuthUser, @Body() dto: InitializePaymentDto, @Req() req: Request, @IdempotencyKey() key?: string) {
    const callbackUrl = dto.returnTo === 'app' ? `${req.protocol}://${req.get('host')}/api/v1/payments/return` : undefined;
    return this.payments.initialize(user, dto.purpose, dto.payableId, key, dto.amountOption, callbackUrl);
  }

  /**
   * Where Paystack sends someone paying inside the phone app. It is deliberately not the website: a short page that
   * says the payment is done, while the app closes the payment window itself and shows the result.
   */
  @Public()
  @Get('return')
  @ApiExcludeEndpoint()
  paymentReturn(@Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nimpat One</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#eef3ee;color:#14281d;text-align:center}
main{padding:32px 24px;max-width:340px}.tick{width:64px;height:64px;border-radius:50%;background:#0b6b3a;color:#fff;display:grid;place-items:center;margin:0 auto 18px;font-size:34px}
h1{font-size:21px;margin:0 0 8px}p{margin:0;color:#4b6155;line-height:1.5;font-size:15px}</style></head>
<body><main><div class="tick">&#10003;</div><h1>Payment finished</h1><p>Taking you back to Nimpat One&hellip;<br>If nothing happens, tap <b>Done</b> or <b>Close</b> at the top.</p></main></body></html>`);
  }

  @Authenticated()
  @Post('verify/:reference')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify a Paystack payment after the customer returns from checkout' })
  verify(@CurrentUser() user: AuthUser, @Param('reference') reference: string) {
    return this.payments.verifyForCustomer(user, checkRef(reference));
  }

  @Authenticated()
  @Post('bank-transfer')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Pay by direct bank transfer: returns the account, amount and the reference to use as narration' })
  startTransfer(@CurrentUser() user: AuthUser, @Body() dto: InitializePaymentDto, @IdempotencyKey() key?: string) {
    return this.manual.startBankTransfer(user, dto.purpose, dto.payableId, dto.amountOption, key);
  }

  @Authenticated()
  @Get('bank-transfer/:reference')
  @ApiOperation({ summary: 'Transfer instructions for one of my bank transfers' })
  transferInstructions(@CurrentUser() user: AuthUser, @Param('reference') reference: string) {
    return this.manual.instructionsForCustomer(user, checkRef(reference));
  }

  @Authenticated()
  @Post('bank-transfer/:reference/notify')
  @HttpCode(200)
  @ApiOperation({ summary: '"I have paid": marks the transfer as awaiting verification by Nimpat finance (not paid)' })
  notify(@CurrentUser() user: AuthUser, @Param('reference') reference: string, @Body() dto: TransferNoticeDto) {
    return this.manual.notifyTransfer(user, checkRef(reference), { ...dto, amountMinor: dto.amountMinor !== undefined ? BigInt(dto.amountMinor) : undefined });
  }

  @Authenticated()
  @Post('bank-transfer/:reference/proofs')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PROOF_BYTES, files: 1 } }))
  @ApiOperation({ summary: 'Attach a transfer receipt (PNG, JPEG or PDF, ≤ 5 MB). Supporting evidence only.' })
  upload(@CurrentUser() user: AuthUser, @Param('reference') reference: string, @UploadedFile() file?: { buffer: Buffer; originalname: string }) {
    return this.manual.uploadProof(user, checkRef(reference), file);
  }

  @Authenticated()
  @Get('proofs/:proofId')
  @ApiOperation({ summary: 'Download a proof-of-payment file (uploader or payments staff only)' })
  async proof(@CurrentUser() user: AuthUser, @Param('proofId', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.manual.readProof(user, id);
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${f.fileName.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(f.buffer);
  }

  @Authenticated()
  @Get('receipts/:reference')
  @ApiOperation({ summary: 'Receipt for a recorded collection or verified payment' })
  receipt(@CurrentUser() user: AuthUser, @Param('reference') reference: string) {
    return this.manual.receipt(user, checkRef(reference));
  }

  @Authenticated()
  @Get()
  @ApiOperation({ summary: 'My payments' })
  mine(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.payments.listForCustomer(user, q);
  }

  /** Paystack → Nimpat One webhook. Configure in the Paystack dashboard. */
  @Public()
  @SkipThrottle()
  @Post('webhooks/paystack')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  webhook(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-paystack-signature') signature?: string) {
    return this.payments.handleWebhook(req.rawBody, signature, req.ip);
  }
}

@ApiTags('Admin · Payments')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly manual: ManualPaymentsService,
  ) {}

  @Get()
  @RequirePermissions(P.paymentsRead)
  @ApiOperation({ summary: 'Payments — filter by division, method, point, status, reconciliation, location, staff and date' })
  list(@CurrentUser() user: AuthUser, @Query() q: AdminPaymentQueryDto) {
    return this.payments.adminList(user, q);
  }

  @Post('reconcile')
  @HttpCode(200)
  @RequirePermissions(P.paymentsReconcile)
  @ApiOperation({ summary: 'Run Paystack reconciliation now (re-verifies open Paystack payments)' })
  reconcileAll() {
    return this.payments.reconcile();
  }

  @Get(':id')
  @RequirePermissions(P.paymentsRead)
  @ApiOperation({ summary: 'Payment with refunds, proofs and the full event log' })
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.adminGet(user, id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @RequirePermissions(P.paymentsRead)
  @ApiOperation({ summary: 'Re-verify a Paystack payment with Paystack now' })
  verify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.adminVerify(user, id);
  }

  @Post(':id/confirm-funds')
  @HttpCode(200)
  @RequirePermissions(P.paymentsVerify)
  @ApiOperation({ summary: 'Finance: confirm a bank transfer or collection from trusted records (not by the person who reported it)' })
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmFundsDto) {
    return this.manual.confirmFunds(user, id, { ...dto, receivedAmountMinor: BigInt(dto.receivedAmountMinor) });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions(P.paymentsVerify)
  @ApiOperation({ summary: 'Finance: funds not found — reject the reported payment' })
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.manual.reject(user, id, dto.reason);
  }

  @Post(':id/dispute')
  @HttpCode(200)
  @RequirePermissions(P.paymentsVerify)
  @ApiOperation({ summary: 'Flag a manual payment for investigation (blocks reconciliation)' })
  dispute(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.manual.dispute(user, id, dto.reason);
  }

  @Post(':id/resolve-dispute')
  @HttpCode(200)
  @RequirePermissions(P.paymentsVerify)
  @ApiOperation({ summary: 'Close a dispute on a verified payment' })
  resolve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) {
    return this.manual.resolveDispute(user, id, dto.note);
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @RequirePermissions(P.paymentsVerify)
  @ApiOperation({ summary: 'Reverse a verified manual payment (bounced transfer, counterfeit cash); balance is recalculated' })
  reverse(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.manual.reverse(user, id, dto.reason);
  }

  @Post(':id/reconcile')
  @HttpCode(200)
  @RequirePermissions(P.paymentsReconcile)
  @ApiOperation({ summary: 'Finance: mark a verified payment as matched to the bank settlement / cash banking' })
  reconcileOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReconcileDto) {
    return this.manual.reconcile(user, id, dto);
  }

  @Post(':id/refunds')
  @RequirePermissions(P.paymentsRefund)
  @ApiOperation({ summary: 'Refund a successful Paystack payment (full or partial)' })
  refund(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto) {
    return this.payments.requestRefund(user, id, dto.amountMinor !== undefined ? BigInt(dto.amountMinor) : undefined, dto.reason);
  }
}

@ApiTags('Admin · Collections & Finance')
@Controller('admin')
export class AdminCollectionsController {
  constructor(private readonly manual: ManualPaymentsService) {}

  @Post('collections')
  @RequirePermissions(P.collectionsRecord)
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Prevents double-recording the same collection on retries' })
  @ApiOperation({ summary: 'Delivery officer / cashier: record money collected (awaits finance verification)' })
  record(@CurrentUser() user: AuthUser, @Body() dto: RecordCollectionDto, @IdempotencyKey() key?: string) {
    return this.manual.recordCollection(user, { ...dto, amountMinor: BigInt(dto.amountMinor), collectedAt: dto.collectedAt ? new Date(dto.collectedAt) : undefined }, key);
  }

  @Get('finance/outstanding')
  @RequirePermissions(P.paymentsRead)
  @ApiOperation({ summary: 'Orders and bookings with balances still owed (deposits, partial payments, pay on delivery)' })
  outstanding(@CurrentUser() user: AuthUser, @Query() q: FinanceQueryDto) {
    return this.manual.outstandingBalances(user, q);
  }

  @Get('finance/collections-by-staff')
  @RequirePermissions(P.paymentsRead)
  @ApiOperation({ summary: 'Staff accountability: collections reported, verified, awaiting and rejected per staff member' })
  byStaff(@CurrentUser() user: AuthUser, @Query() q: FinanceQueryDto) {
    return this.manual.collectionsByStaff(user, q);
  }
}

@ApiTags('Admin · Payment settings')
@Controller('admin/payment-settings')
export class PaymentSettingsController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get('bank-accounts')
  @RequirePermissions(P.paymentsConfigure, P.paymentsVerify)
  @ApiOperation({ summary: 'Receiving bank accounts (numbers masked unless you can configure them)' })
  accounts(@CurrentUser() user: AuthUser) {
    return this.settings.listAccounts(user);
  }

  @Post('bank-accounts')
  @RequirePermissions(P.paymentsConfigure)
  createAccount(@CurrentUser() user: AuthUser, @Body() dto: BankAccountDto) {
    return this.settings.createAccount(user, dto);
  }

  @Patch('bank-accounts/:id')
  @RequirePermissions(P.paymentsConfigure)
  updateAccount(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBankAccountDto) {
    return this.settings.updateAccount(user, id, dto);
  }

  @Get('service-locations')
  @RequirePermissions(P.paymentsConfigure, P.collectionsRecord, P.paymentsRead)
  locations(@Query('division') division?: string) {
    return this.settings.listLocations(division);
  }

  @Post('service-locations')
  @RequirePermissions(P.paymentsConfigure)
  createLocation(@CurrentUser() user: AuthUser, @Body() dto: ServiceLocationDto) {
    return this.settings.createLocation(user, dto as any);
  }

  @Patch('service-locations/:id')
  @RequirePermissions(P.paymentsConfigure)
  updateLocation(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceLocationDto) {
    const { division, ...rest } = dto;
    if (division) throw new BadRequestException('A location cannot move to another division');
    return this.settings.updateLocation(user, id, rest);
  }

  @Get('policies')
  @RequirePermissions(P.paymentsConfigure, P.paymentsRead)
  @ApiOperation({ summary: 'Effective payment policy for every division and transaction type' })
  policies() {
    return this.settings.listPolicies();
  }

  @Put('policies/:division/:purpose')
  @RequirePermissions(P.paymentsConfigure)
  @ApiOperation({ summary: 'Set which payment methods, deposits and confirmation rule apply' })
  setPolicy(@CurrentUser() user: AuthUser, @Param('division') division: string, @Param('purpose') purpose: PaymentPurpose, @Body() dto: PaymentPolicyDto) {
    if (!Object.values(PaymentPurpose).includes(purpose)) throw new BadRequestException('Unknown transaction type');
    return this.settings.upsertPolicy(user, division, purpose, dto);
  }
}
