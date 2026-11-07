import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Authenticated, CurrentUser, Public } from '../../common/decorators/auth.decorators';
import { AuthUser } from '../access/auth-user';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  EmailOnlyDto,
  GuestDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  UpgradeGuestDto,
  ResetPasswordDto,
  TokenResponseDto,
  VerifyEmailDto,
} from './dto/auth.dto';

/** Stricter per-IP limits on credential endpoints (resolved at request time). */
const AuthThrottle = () =>
  Throttle({
    default: {
      limit: () => Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
      ttl: () => Number(process.env.RATE_LIMIT_TTL_SECONDS ?? 60) * 1000,
    },
  });

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @AuthThrottle()
  @Post('register')
  @ApiOperation({ summary: 'Register a customer account (sends a verification email)' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public() @AuthThrottle()
  @Post('guest')
  @ApiOperation({ summary: 'Check out as a guest: name, email and phone, no password. Guests do not earn Royalty points' })
  guest(@Body() dto: GuestDto) {
    return this.auth.startGuest(dto);
  }

  @Post('guest/upgrade')
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn the signed-in guest into a full account with a password, keeping their orders' })
  upgradeGuest(@CurrentUser() user: AuthUser, @Body() dto: UpgradeGuestDto) {
    return this.auth.upgradeGuest(user, dto);
  }

  @Public() @AuthThrottle()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public() @AuthThrottle()
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiOperation({ summary: 'Exchange a refresh token for new tokens (rotation)' })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the current session' })
  logout(@CurrentUser() user: AuthUser) {
    return this.auth.logout(user);
  }

  @Authenticated()
  @Post('logout-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'End all sessions on all devices' })
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user);
  }

  @Public() @AuthThrottle()
  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an email address with the emailed token' })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @Public() @AuthThrottle()
  @Post('resend-verification')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resend the verification email' })
  resend(@Body() dto: EmailOnlyDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Public() @AuthThrottle()
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a password reset link (always returns ok)' })
  forgot(@Body() dto: EmailOnlyDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public() @AuthThrottle()
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password with a reset token; signs out all sessions' })
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Authenticated() @AuthThrottle()
  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change password (signs out other devices)' })
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto);
  }

  @Authenticated()
  @Get('me')
  @ApiOperation({ summary: 'Current user, roles and effective permissions' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
