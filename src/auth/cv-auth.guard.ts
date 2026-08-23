import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

export const AUTH_FETCH = 'CV_AUTH_FETCH';
export const AUTH_SERVICE_URL = 'CV_AUTH_SERVICE_URL';

const VALIDATE_TIMEOUT_MS = 3000;

export interface CvUser {
  id: string;
  email: string;
}

interface AuthValidateResponse {
  valid?: boolean;
  user?: CvUser;
}

@Injectable()
export class CvAuthGuard implements CanActivate {
  private readonly logger = new Logger(CvAuthGuard.name);

  constructor(
    @Optional() @Inject(AUTH_SERVICE_URL) private readonly authServiceUrl: string = process.env.AUTH_SERVICE_URL ?? '',
    @Optional() @Inject(AUTH_FETCH) private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: CvUser }>();
    const token = this.readBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    request.user = await this.validate(token);
    return true;
  }

  private readBearerToken(header: string | undefined): string | null {
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
    return value;
  }

  /**
   * A rejected credential and an unreachable auth service are different outcomes and must
   * stay distinguishable: 401 tells the user to log in again, 503 tells us auth is down.
   * Collapsing them (as some services in this ecosystem do) hides the outage entirely.
   */
  private async validate(token: string): Promise<CvUser> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.authServiceUrl}/auth/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`auth-microservice unreachable at ${this.authServiceUrl}/auth/validate: ${message}`);
      throw new ServiceUnavailableException('auth-microservice is unreachable');
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedException('Invalid token');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      this.logger.error(
        `auth-microservice returned ${response.status} for /auth/validate: ${body.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException('auth-microservice returned an error');
    }

    let validation: AuthValidateResponse;
    try {
      validation = (await response.json()) as AuthValidateResponse;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(`auth-microservice returned an unparseable body: ${message}`);
      throw new ServiceUnavailableException('auth-microservice returned an unparseable response');
    }

    if (!validation.valid || !validation.user) {
      throw new UnauthorizedException('Invalid token');
    }

    return validation.user;
  }
}
