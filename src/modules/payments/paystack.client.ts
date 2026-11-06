import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';

export interface PaystackInitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackTransaction {
  id: number;
  status: 'success' | 'failed' | 'abandoned' | 'ongoing' | 'pending' | 'processing' | 'queued' | 'reversed' | string;
  reference: string;
  amount: number; // kobo
  currency: string;
  channel?: string;
  gateway_response?: string;
  paid_at?: string | null;
  fees?: number | null;
  customer?: { email?: string };
  metadata?: unknown;
}

export interface PaystackRefund {
  id: number;
  status: 'pending' | 'processing' | 'processed' | 'failed' | 'needs-attention' | string;
  amount: number;
  currency: string;
  transaction?: { id: number; reference: string } | number;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

/**
 * Thin, typed Paystack REST client (test mode only — enforced at startup).
 * All amounts are integers in kobo, exactly as Paystack expects.
 */
@Injectable()
export class PaystackClient {
  private readonly logger = new Logger(PaystackClient.name);

  constructor(private readonly config: AppConfig) {}

  initialize(body: {
    email: string;
    amount: number;
    reference: string;
    currency: string;
    callback_url?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaystackInitializeResult> {
    return this.request<PaystackInitializeResult>('POST', '/transaction/initialize', body);
  }

  verify(reference: string): Promise<PaystackTransaction> {
    return this.request<PaystackTransaction>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  }

  createRefund(body: { transaction: string; amount?: number; merchant_note?: string; customer_note?: string }): Promise<PaystackRefund> {
    return this.request<PaystackRefund>('POST', '/refund', body);
  }

  fetchRefund(id: string): Promise<PaystackRefund> {
    return this.request<PaystackRefund>('GET', `/refund/${encodeURIComponent(id)}`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.config.get('PAYSTACK_BASE_URL').replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.get('PAYSTACK_SECRET_KEY')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.error(`Paystack ${method} ${path} network error: ${(e as Error).message}`);
      throw new BadGatewayException('Payment provider is unreachable. Please try again.');
    }
    let json: PaystackEnvelope<T> | undefined;
    try {
      json = (await res.json()) as PaystackEnvelope<T>;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || !json?.status) {
      this.logger.warn(`Paystack ${method} ${path} failed: HTTP ${res.status} ${json?.message ?? ''}`);
      throw new PaystackError(res.status, json?.message ?? `HTTP ${res.status}`);
    }
    return json.data;
  }
}

export class PaystackError extends BadGatewayException {
  constructor(
    readonly httpStatus: number,
    readonly providerMessage: string,
  ) {
    super(`Payment provider error: ${providerMessage}`);
  }
}
