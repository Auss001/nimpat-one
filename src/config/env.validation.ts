import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  development = 'development',
  test = 'test',
  production = 'production',
}

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';
const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

/** Validated, typed environment. The app refuses to start on bad config. */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.development;

  @Transform(toInt) @IsInt() @Min(1) @Max(65535)
  PORT = 4000;

  @IsString()
  CORS_ORIGINS = '';

  @IsUrl({ require_tld: false })
  APP_PUBLIC_URL = 'http://localhost:3000';

  @IsUrl({ require_tld: false })
  ADMIN_PUBLIC_URL = 'http://localhost:3001';

  @Transform(toBool) @IsBoolean()
  TRUST_PROXY = true;

  @IsString()
  DATABASE_URL!: string;

  @IsString() @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @Transform(toInt) @IsInt() @Min(60) @Max(3600)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Transform(toInt) @IsInt() @Min(1) @Max(90)
  REFRESH_TOKEN_TTL_DAYS = 30;

  @Transform(toInt) @IsInt() @Min(1)
  EMAIL_VERIFICATION_TTL_HOURS = 24;

  @Transform(toInt) @IsInt() @Min(5)
  PASSWORD_RESET_TTL_MINUTES = 30;

  @Transform(toBool) @IsBoolean()
  REQUIRE_VERIFIED_EMAIL_FOR_PAYMENT = true;

  @Transform(toInt) @IsInt() @Min(1)
  RATE_LIMIT_TTL_SECONDS = 60;

  @Transform(toInt) @IsInt() @Min(1)
  RATE_LIMIT_MAX = 120;

  @Transform(toInt) @IsInt() @Min(1)
  AUTH_RATE_LIMIT_MAX = 10;

  /** "test" (default) or "live". Live takes real money, so it is only allowed in production. */
  @IsIn(['test', 'live'])
  PAYSTACK_MODE: 'test' | 'live' = 'test';

  @IsString()
  PAYSTACK_SECRET_KEY!: string;

  @IsOptional() @IsString()
  PAYSTACK_PUBLIC_KEY?: string;

  @IsUrl()
  PAYSTACK_BASE_URL = 'https://api.paystack.co';

  @IsOptional() @IsUrl({ require_tld: false })
  PAYSTACK_CALLBACK_URL?: string;

  @IsOptional() @IsString()
  PAYSTACK_WEBHOOK_IP_ALLOWLIST?: string;

  @Transform(toInt) @IsInt() @Min(5)
  ORDER_PAYMENT_TTL_MINUTES = 30;

  @Transform(toInt) @IsInt() @Min(5)
  APARTMENT_HOLD_TTL_MINUTES = 15;

  @Transform(toInt) @IsInt() @Min(5)
  SPA_HOLD_TTL_MINUTES = 20;

  @IsString()
  BUSINESS_TIMEZONE = 'Africa/Lagos';

  @Transform(toBool) @IsBoolean()
  JOBS_INPROCESS = false;

  @IsString() @MinLength(16)
  JOBS_TOKEN!: string;

  /** "console" logs emails (development); "resend" sends them through Resend. */
  @IsIn(['console', 'resend'])
  MAIL_TRANSPORT = 'console';

  @IsString()
  EMAIL_FROM = 'Nimpat One <no-reply@notify.nimpatgroup.com>';

  /** Firebase project for phone notifications (the Google Cloud project id). Unset = no phone notifications. */
  @IsOptional() @IsString()
  FCM_PROJECT_ID?: string;

  /** Secret. Required when MAIL_TRANSPORT is "resend"; never logged. */
  @ValidateIf((env: EnvironmentVariables) => env.MAIL_TRANSPORT === 'resend')
  @IsString()
  @MinLength(10)
  RESEND_API_KEY?: string;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${details}`);
  }

  // Paystack: the key must match the mode, so a live key can never slip into test mode or the reverse.
  // Live mode is refused outside production, so a developer's computer always uses test mode.
  const mode = env.PAYSTACK_MODE;
  if (mode === 'live' && env.NODE_ENV !== NodeEnv.production) {
    throw new Error('PAYSTACK_MODE=live is only allowed in production. Use test mode on development machines.');
  }
  if (!env.PAYSTACK_SECRET_KEY.startsWith(`sk_${mode}_`)) {
    throw new Error(`PAYSTACK_SECRET_KEY must be a Paystack ${mode.toUpperCase()} secret key (sk_${mode}_...) because PAYSTACK_MODE=${mode}.`);
  }
  if (env.PAYSTACK_PUBLIC_KEY && !env.PAYSTACK_PUBLIC_KEY.startsWith(`pk_${mode}_`)) {
    throw new Error(`PAYSTACK_PUBLIC_KEY must be a Paystack ${mode.toUpperCase()} public key (pk_${mode}_...).`);
  }
  if (env.NODE_ENV === NodeEnv.production && env.JWT_ACCESS_SECRET.startsWith('dev-only')) {
    throw new Error('JWT_ACCESS_SECRET still has the development placeholder value.');
  }
  if (env.NODE_ENV === NodeEnv.production && env.JOBS_TOKEN.startsWith('dev-only')) {
    throw new Error('JOBS_TOKEN still has the development placeholder value.');
  }
  return env;
}
