import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvProfileEntity } from './entities/cv-profile.entity';

/** Version the published CV-processing notice separately from auth or marketing consent. */
export const CV_CONSENT_VERSION = '2026-08-27';

@Injectable()
export class ConsentService {
  constructor(
    @InjectRepository(CvProfileEntity)
    private readonly profiles: Repository<CvProfileEntity>,
  ) {}

  async get(userId: string): Promise<CvProfileEntity> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException(`profile ${userId} not found`);
    }
    return profile;
  }

  async grant(userId: string, version = CV_CONSENT_VERSION): Promise<CvProfileEntity> {
    const profile = await this.profiles.findOne({ where: { userId } });
    const saved = profile
      ? profile
      : this.profiles.create({ userId, locale: 'en', consentVersion: null, consentAt: null });

    // Repeating the same consent is idempotent and must not rewrite the evidence timestamp.
    if (saved.consentVersion !== version) {
      saved.consentVersion = version;
      saved.consentAt = new Date();
    }
    return this.profiles.save(saved);
  }

  /**
   * Whether the user currently holds consent for the published notice version. Consent is
   * to a SPECIFIC version (spec §9): an older grant does not count once the notice changes,
   * so re-publishing the notice re-gates every processing route until the user re-consents.
   * A missing profile is simply "no consent" — the caller decides what that forbids.
   */
  async hasCurrentConsent(userId: string, version = CV_CONSENT_VERSION): Promise<boolean> {
    const profile = await this.profiles.findOne({ where: { userId } });
    return !!profile && profile.consentVersion === version;
  }
}
