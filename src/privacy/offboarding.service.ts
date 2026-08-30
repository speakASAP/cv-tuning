import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvProfileEntity } from '../master/entities/cv-profile.entity';
import { AccountDeletionService } from './account-deletion.service';
import { IDENTITY_PROVIDER, IdentityProviderPort } from './identity-provider';

export interface ReconcileReport {
  status: 'ok' | 'blocked';
  /** Present when blocked, explaining why nothing was reconciled. */
  reason?: string;
  checked: number;
  purged: number;
  /** Accounts the provider could not confirm either way; left intact rather than guessed. */
  unresolved: number;
  purgedUserIds: string[];
}

/**
 * Offboarding reconciliation (spec §3.2): find `cv_profile` rows whose auth account is gone and
 * hard-delete them, so PII does not persist after a user deletes their identity.
 *
 * The check goes through `IdentityProviderPort`, which calls auth-microservice's protected,
 * existence-only endpoint when configured. When the capability is unavailable the job refuses to
 * run and reports `blocked`. It NEVER purges on an unconfirmed signal: only a provider that
 * positively CONFIRMS an account is gone triggers a delete, so an auth outage can never cascade
 * into deleting a live user's data.
 */
@Injectable()
export class OffboardingService {
  private readonly logger = new Logger(OffboardingService.name);

  constructor(
    @InjectRepository(CvProfileEntity) private readonly profiles: Repository<CvProfileEntity>,
    @Inject(IDENTITY_PROVIDER) private readonly idp: IdentityProviderPort,
    private readonly deletion: AccountDeletionService,
  ) {}

  async reconcile(): Promise<ReconcileReport> {
    if (!this.idp.available) {
      const reason =
        'no identity-provider lookup capability (AUTH_USER_LOOKUP_URL unset); reconciliation ' +
        'cannot run without an authoritative account-existence answer';
      this.logger.warn(`offboarding reconciliation blocked: ${reason}`);
      return { status: 'blocked', reason, checked: 0, purged: 0, unresolved: 0, purgedUserIds: [] };
    }

    const profiles = await this.profiles.find({ select: ['userId'] });
    let purged = 0;
    let unresolved = 0;
    const purgedUserIds: string[] = [];

    for (const { userId } of profiles) {
      const exists = await this.idp.userExists(userId);
      if (exists === false) {
        await this.deletion.deleteAccount(userId);
        purged += 1;
        purgedUserIds.push(userId);
        this.logger.log(`offboarding: purged orphaned data for deleted auth account ${userId}`);
      } else if (exists === null) {
        // Could not confirm — never delete on uncertainty.
        unresolved += 1;
        this.logger.warn(`offboarding: could not confirm auth account ${userId}; leaving data intact`);
      }
    }

    return { status: 'ok', checked: profiles.length, purged, unresolved, purgedUserIds };
  }
}
