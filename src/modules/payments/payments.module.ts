import { Global, Module } from '@nestjs/common';
import { ManualPaymentsService } from './manual-payments.service';
import { PayableRegistry } from './payable.registry';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentPolicyService } from './payment-policy.service';
import { PaymentSettingsService } from './payment-settings.service';
import { AdminCollectionsController, AdminPaymentsController, PaymentSettingsController, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaystackClient } from './paystack.client';
import { ProofStorageService } from './proof-storage.service';

@Global()
@Module({
  providers: [
    PayableRegistry,
    PaystackClient,
    PaymentLedgerService,
    PaymentPolicyService,
    PaymentsService,
    ProofStorageService,
    ManualPaymentsService,
    PaymentSettingsService,
  ],
  controllers: [PaymentsController, AdminPaymentsController, AdminCollectionsController, PaymentSettingsController],
  exports: [PayableRegistry, PaymentsService, PaymentLedgerService, PaymentPolicyService],
})
export class PaymentsModule {}
