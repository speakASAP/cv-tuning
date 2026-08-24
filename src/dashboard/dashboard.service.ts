import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  APPLICATION_STATES,
  ApplicationState,
  Outcome,
  OUTCOMES,
} from '../applications/application.types';
import { CvApplicationEntity } from '../applications/entities/cv-application.entity';

export interface DashboardFunnel {
  generated: number;
  approved: number;
  downloaded: number;
  sent: number;
  replied: number;
}

export interface DashboardSummary {
  total: number;
  byState: Record<ApplicationState, number>;
  byOutcome: Record<Outcome, number>;
  funnel: DashboardFunnel;
  /** Interviews-or-better over sent applications. Null when nothing has been sent. */
  interviewRate: number | null;
  /** Median days from send to recorded outcome. Null when nothing has replied. */
  medianReplyDays: number | null;
}

/**
 * The funnel is CUMULATIVE: an application in `marked_sent` was necessarily downloaded and
 * approved on the way there, so each stage counts everything at or past it. Reporting the raw
 * per-state counts as a funnel would show a "downloaded" bar that shrinks as users progress.
 */
const AT_OR_PAST: Record<keyof DashboardFunnel, readonly ApplicationState[]> = {
  generated: APPLICATION_STATES,
  approved: ['approved', 'downloaded', 'marked_sent'],
  downloaded: ['downloaded', 'marked_sent'],
  sent: ['marked_sent'],
  replied: [],
};

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectRepository(CvApplicationEntity)
    private readonly applications: Repository<CvApplicationEntity>,
  ) {}

  async summary(userId: string): Promise<DashboardSummary> {
    // Aggregated in SQL, not in JS: loading every row to count them would grow linearly with
    // the user's history for a number Postgres produces in one pass.
    const stateRows = await this.applications
      .createQueryBuilder('app')
      .select('app.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .where('app."userId" = :userId', { userId })
      .groupBy('app.state')
      .getRawMany<{ state: ApplicationState; count: string }>();

    const outcomeRows = await this.applications
      .createQueryBuilder('app')
      .select('app.outcome', 'outcome')
      .addSelect('COUNT(*)', 'count')
      .where('app."userId" = :userId', { userId })
      .andWhere('app.outcome IS NOT NULL')
      .groupBy('app.outcome')
      .getRawMany<{ outcome: Outcome; count: string }>();

    const replyRows = await this.applications
      .createQueryBuilder('app')
      .select('EXTRACT(EPOCH FROM (app."outcomeAt" - app."sentAt")) / 86400', 'days')
      .where('app."userId" = :userId', { userId })
      .andWhere('app."sentAt" IS NOT NULL')
      .andWhere('app."outcomeAt" IS NOT NULL')
      .getRawMany<{ days: string }>();

    // Every key present with an explicit 0: a missing key renders as a hole in a UI, while 0 is
    // a real and useful answer.
    const byState = Object.fromEntries(APPLICATION_STATES.map((state) => [state, 0])) as Record<
      ApplicationState,
      number
    >;
    for (const row of stateRows) {
      byState[row.state] = Number(row.count);
    }

    const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
    for (const row of outcomeRows) {
      byOutcome[row.outcome] = Number(row.count);
    }

    const total = Object.values(byState).reduce((sum, n) => sum + n, 0);
    const sumOf = (states: readonly ApplicationState[]): number =>
      states.reduce((sum, state) => sum + byState[state], 0);

    const replied = Object.values(byOutcome).reduce((sum, n) => sum + n, 0);
    const funnel: DashboardFunnel = {
      generated: total,
      approved: sumOf(AT_OR_PAST.approved),
      downloaded: sumOf(AT_OR_PAST.downloaded),
      sent: sumOf(AT_OR_PAST.sent),
      replied,
    };

    // An offer necessarily passed the interview stage; excluding it would under-report success.
    const interviews = byOutcome.interview + byOutcome.offer;
    const interviewRate = funnel.sent > 0 ? interviews / funnel.sent : null;

    return {
      total,
      byState,
      byOutcome,
      funnel,
      interviewRate,
      medianReplyDays: this.median(replyRows.map((r) => Number(r.days))),
    };
  }

  /** Median, not mean: one application answered after six months would drag a mean into fiction. */
  private median(values: number[]): number | null {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
}
