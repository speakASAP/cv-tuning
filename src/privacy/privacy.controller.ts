import { Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { AccountDeletionService } from './account-deletion.service';
import { DataExportService } from './data-export.service';
import { OffboardingService } from './offboarding.service';
import { RetentionService } from './retention.service';

interface AuthedRequest {
  user: CvUser;
}

/**
 * Data-subject-rights and GDPR-maintenance routes (spec §9).
 *
 * All routes are under `CvAuthGuard` but deliberately NOT under `ConsentGuard`: export and
 * deletion are rights a user keeps even after withdrawing consent, and blocking them on consent
 * would be the opposite of what §9 requires.
 *
 * `retention` and `reconcile` are owner/ops triggers. No scheduler lives in this service
 * (AGENTS.md — timing belongs to BPCP); these expose the operations so a scheduler or operator can
 * invoke them. The service has no third-party ingress, so owner-token auth is the current gate.
 */
@Controller('api/privacy')
@UseGuards(CvAuthGuard)
export class PrivacyController {
  constructor(
    private readonly dataExport: DataExportService,
    private readonly deletion: AccountDeletionService,
    private readonly retention: RetentionService,
    private readonly offboarding: OffboardingService,
  ) {}

  /** Right to portability: the full data export for the authenticated user. */
  @Get('export')
  async export(@Req() req: AuthedRequest) {
    return this.dataExport.export(req.user.id);
  }

  /** Right to erasure: hard-delete cascade for the authenticated user. */
  @Delete('account')
  async deleteAccount(@Req() req: AuthedRequest) {
    return this.deletion.deleteAccount(req.user.id);
  }

  /** Retention sweep: expire third-party posting text and purge orphaned artifacts. */
  @Post('retention')
  async runRetention() {
    return this.retention.run();
  }

  /** Offboarding reconciliation against the identity provider (blocked until auth exposes a lookup). */
  @Post('reconcile')
  async reconcile() {
    return this.offboarding.reconcile();
  }
}
