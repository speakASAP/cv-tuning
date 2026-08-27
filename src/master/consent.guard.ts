import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CvUser } from '../auth/cv-auth.guard';
import { ConsentService, CV_CONSENT_VERSION } from './consent.service';

/**
 * Gates CV-processing routes on CURRENT consent (spec §9). Applied at method level on the
 * routes that ingest or derive from the user's CV, and deliberately NOT on read-only or
 * data-subject-rights routes: a user who has withdrawn consent must still be able to read,
 * export, and delete what the service already holds.
 *
 * Runs AFTER `CvAuthGuard` (controller-level guards execute before method-level ones), so it
 * reads `req.user` rather than re-validating the token. If `req.user` is somehow unset it
 * fails closed rather than treating an unauthenticated request as consented.
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(private readonly consent: ConsentService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: CvUser }>();
    const user = request.user;

    if (!user?.id) {
      throw new UnauthorizedException('authentication is required before consent can be checked');
    }

    if (!(await this.consent.hasCurrentConsent(user.id))) {
      throw new ForbiddenException(
        `CV processing requires current consent (notice version ${CV_CONSENT_VERSION}); ` +
          'grant it at POST /api/master/consent',
      );
    }

    return true;
  }
}
