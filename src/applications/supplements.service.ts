import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { JobsService } from '../jobs/jobs.service';
import { MasterCvService } from '../master/master-cv.service';
import { scoreAiTell } from './ai-tell';
import { FactSnapshot } from './application.types';
import { buildCoverLetterMarkdown } from './cover-letter-render';
import { CoverLetterService } from './cover-letter.service';
import { CvApplicationEntity } from './entities/cv-application.entity';
import { CvSupplementEntity } from './entities/cv-supplement.entity';
import { EntailService } from './entail.service';
import { extractContactLines, extractH1Name } from './render-markdown';
import { mergeQuestions } from './screening-questions';
import { ScreeningService } from './screening.service';
import { DraftBullet } from './tailor.service';
import {
  CoverLetterParagraph,
  DroppedParagraph,
  ScreeningAnswer,
  SupplementKind,
  SupplementProvenance,
} from './supplement.types';

/** Matches the CV path: the first few facts carry the user's own voice into the prompt. */
const STYLE_EXEMPLAR_COUNT = 5;

/** A paste accident must not build an unbounded prompt. */
const MAX_QUESTIONS = 25;

export interface CoverLetterRequest {
  tone?: 'plain' | 'warm';
  language?: string;
}

export interface ScreeningRequest {
  questions?: string[];
  language?: string;
}

/**
 * Owns the pipeline both supplement kinds share: ownership check, pinned facts, layer 1
 * generation, layer 2 entailment, assembly, AI-tell scoring, and persistence.
 *
 * Layer 2 is `EntailService.validate()` with its signature UNCHANGED. That reuse is what this
 * whole phase rests on: a cover-letter paragraph and a screening answer are both "a claim bound
 * to one fact", so there is exactly one implementation of the anti-fabrication core in the
 * codebase rather than three that must be kept in sync.
 */
@Injectable()
export class SupplementsService {
  private readonly logger = new Logger(SupplementsService.name);

  constructor(
    @InjectRepository(CvSupplementEntity)
    private readonly supplements: Repository<CvSupplementEntity>,
    @InjectRepository(CvApplicationEntity)
    private readonly applications: Repository<CvApplicationEntity>,
    private readonly master: MasterCvService,
    private readonly jobs: JobsService,
    private readonly coverLetter: CoverLetterService,
    private readonly screening: ScreeningService,
    private readonly entail: EntailService,
  ) {}

  async generateCoverLetter(
    userId: string,
    applicationId: string,
    request: CoverLetterRequest,
  ): Promise<CvSupplementEntity> {
    const context = await this.load(userId, applicationId, 'cover_letter', request);
    if (context.existing) {
      return context.existing;
    }

    const drafted = await this.coverLetter.generate({
      facts: context.snapshot,
      requirements: context.requirements,
      jobTitle: context.jobTitle,
      company: context.company,
      language: request.language ?? context.language,
      styleExemplars: context.styleExemplars,
      tone: request.tone ?? 'plain',
    });

    const validated = await this.entail.validate(drafted.paragraphs, context.snapshot);
    const { kept, dropped } = this.partition(validated.bullets);

    const content = buildCoverLetterMarkdown({
      candidateName: extractH1Name(context.masterMarkdown),
      contactLine: this.contactLine(context.masterMarkdown),
      jobTitle: context.jobTitle,
      company: context.company,
      paragraphs: kept.map((p) => p.text),
      language: request.language ?? context.language,
    });

    const provenance: SupplementProvenance = {
      paragraphs: kept,
      droppedParagraphs: [...drafted.droppedParagraphs, ...dropped],
    };

    return this.persist(context, content, provenance, drafted, validated);
  }

  async generateScreening(
    userId: string,
    applicationId: string,
    request: ScreeningRequest,
  ): Promise<CvSupplementEntity> {
    const context = await this.load(userId, applicationId, 'screening', request);
    if (context.existing) {
      return context.existing;
    }

    const questions = mergeQuestions(
      (request.questions ?? []).slice(0, MAX_QUESTIONS),
      context.parsedQuestions,
    );

    const drafted = await this.screening.generate({
      facts: context.snapshot,
      questions: questions.map((q) => q.text),
      jobTitle: context.jobTitle,
      company: context.company,
      language: request.language ?? context.language,
      styleExemplars: context.styleExemplars,
    });

    const answers: ScreeningAnswer[] = questions.map((question) => {
      const generated = drafted.answers.find((a) => a.question === question.text);
      return {
        question: question.text,
        questionSource: question.source,
        paragraphs: [],
        droppedParagraphs: [...(generated?.droppedParagraphs ?? [])],
      };
    });

    const answerIndexByQuestion = new Map(questions.map((q, i) => [q.text, i]));

    // ONE entailment call for every question's paragraphs. Flattened with the question index
    // recorded so verdicts can be re-attached; N calls would N-fold cost for no benefit.
    const flat: DraftBullet[] = [];
    const owners: number[] = [];
    for (const answer of drafted.answers) {
      const owner = answerIndexByQuestion.get(answer.question);
      if (owner === undefined) {
        // ScreeningService already drops answers to unasked questions. Reaching here means one
        // slipped through, and validating it would put an unrequested answer in the document.
        this.logger.error(
          `screening returned an answer to a question that was not asked: "${answer.question}"; ignoring it`,
        );
        continue;
      }
      for (const paragraph of answer.paragraphs) {
        flat.push(paragraph);
        owners.push(owner);
      }
    }

    const validated = await this.entail.validate(flat, context.snapshot);

    // Re-attached BY INDEX, not by sourceFactId. EntailService returns verdicts in input
    // order, and two different questions may legitimately cite the same fact — which makes
    // sourceFactId ambiguous as a key, and would attach one question's verdict to another's
    // paragraph.
    // Built from the MERGED question list, not from what the generator returned. ScreeningService
    // already guarantees one answer per asked question, but relying on that here would make a
    // future regression there silently drop a question from the user's document instead of
    // failing loudly — and the user would find the gap on the employer's form.
    const droppedAll: DroppedParagraph[] = [...drafted.droppedParagraphs];

    validated.bullets.forEach((bullet, i) => {
      const answer = answers[owners[i]];
      if (bullet.verdict === 'supported') {
        answer.paragraphs.push(this.toParagraph(bullet));
        return;
      }
      const dropped = this.toDropped(bullet);
      answer.droppedParagraphs.push(dropped);
      droppedAll.push(dropped);
    });

    const content = this.buildScreeningMarkdown(answers);

    const provenance: SupplementProvenance = {
      paragraphs: answers.flatMap((a) => a.paragraphs),
      droppedParagraphs: droppedAll,
      answers,
    };

    return this.persist(context, content, provenance, drafted, validated);
  }

  async list(userId: string, applicationId: string): Promise<CvSupplementEntity[]> {
    await this.findOwned(userId, applicationId);
    return this.supplements.find({
      where: { applicationId },
      order: { kind: 'ASC', revisionNo: 'ASC' },
    });
  }

  async get(
    userId: string,
    applicationId: string,
    kind: SupplementKind,
    revisionNo: number,
  ): Promise<CvSupplementEntity> {
    await this.findOwned(userId, applicationId);
    const supplement = await this.supplements.findOne({
      where: { applicationId, kind, revisionNo },
    });

    if (!supplement) {
      throw new NotFoundException(
        `application ${applicationId} has no ${kind} revision ${revisionNo}`,
      );
    }

    return supplement;
  }

  /**
   * Everything both kinds need, plus the idempotency short-circuit.
   *
   * The pinned master version is loaded, NEVER `is_current` (spec §4.2): a supplement is
   * generated against the same facts the CV was, or it would cite an achievement the CV it
   * accompanies does not contain.
   */
  private async load(
    userId: string,
    applicationId: string,
    kind: SupplementKind,
    request: CoverLetterRequest | ScreeningRequest,
  ): Promise<{
    application: CvApplicationEntity;
    snapshot: FactSnapshot[];
    masterMarkdown: string;
    requirements: { text: string; kind: 'must' | 'nice' }[];
    parsedQuestions: string[];
    jobTitle: string | null;
    company: string | null;
    language: string;
    styleExemplars: string[];
    kind: SupplementKind;
    revisionNo: number;
    idempotencyKey: string;
    existing: CvSupplementEntity | null;
  }> {
    const application = await this.findOwned(userId, applicationId);

    const pinned = await this.master.getVersion(userId, application.masterVersionId);
    if (!pinned) {
      // The pin is the guarantee that a supplement is reproducible. A missing pinned version
      // is data loss, not an empty result.
      throw new Error(
        `application ${application.id} pins master version ${application.masterVersionId}, which no longer exists`,
      );
    }

    const { job } = await this.jobs.get(userId, application.jobId);
    if (!job.parsed) {
      throw new ConflictException(`job ${application.jobId} has no parsed requirements`);
    }

    const last = await this.supplements.findOne({
      where: { applicationId, kind },
      order: { revisionNo: 'DESC' },
    });
    const revisionNo = (last?.revisionNo ?? 0) + 1;

    // Derived from the request body as well as the revision, so a retried POST returns the
    // existing row while a genuinely different request produces a new revision.
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(request ?? {}))
      .digest('hex')
      .slice(0, 16);
    const idempotencyKey = `${applicationId}:${kind}:${bodyHash}`;

    const existing = await this.supplements.findOne({ where: { idempotencyKey } });
    if (existing) {
      // A retried request must not spend a second pair of LLM calls.
      this.logger.warn(
        `supplement ${idempotencyKey} already exists; returning it instead of regenerating`,
      );
    }

    const snapshot = pinned.facts.map((fact) => ({
      factId: fact.factId,
      text: fact.text,
      kind: fact.kind,
      section: fact.section,
      title: fact.title,
      org: fact.org,
      period: fact.period,
    }));

    return {
      application,
      snapshot,
      masterMarkdown: pinned.master.markdown,
      requirements: job.parsed.requirements,
      parsedQuestions: job.parsed.screeningQuestions ?? [],
      jobTitle: job.title,
      company: job.company,
      language: application.renderLanguage,
      styleExemplars: snapshot.slice(0, STYLE_EXEMPLAR_COUNT).map((f) => f.text),
      kind,
      revisionNo,
      idempotencyKey,
      existing,
    };
  }

  /**
   * Splits validated claims into what ships and what is dropped, applying the same rule the CV
   * path applies to a failing bullet.
   */
  private partition(bullets: { text: string; sourceFactId: string; targetRequirement?: string | null; verdict: string; span: string | null }[]): {
    kept: CoverLetterParagraph[];
    dropped: DroppedParagraph[];
  } {
    const kept: CoverLetterParagraph[] = [];
    const dropped: DroppedParagraph[] = [];

    for (const bullet of bullets) {
      if (bullet.verdict === 'supported') {
        kept.push(this.toParagraph(bullet));
        continue;
      }
      dropped.push(this.toDropped(bullet));
    }

    return { kept, dropped };
  }

  private toParagraph(bullet: {
    text: string;
    sourceFactId: string;
    targetRequirement?: string | null;
    verdict: string;
    span: string | null;
  }): CoverLetterParagraph {
    return {
      text: bullet.text,
      sourceFactId: bullet.sourceFactId,
      targetRequirement: bullet.targetRequirement ?? null,
      verdict: bullet.verdict as CoverLetterParagraph['verdict'],
      span: bullet.span,
    };
  }

  private toDropped(bullet: { text: string; verdict: string; span: string | null }): DroppedParagraph {
    if (!bullet.span) {
      // EntailService synthesizes a span for every downgrade precisely so the reason survives.
      // A null here means that invariant broke upstream, and dropping a paragraph without
      // saying which words caused it would leave the user nothing to act on.
      throw new Error(
        `paragraph was validated "${bullet.verdict}" with no span; refusing to drop it without a reason`,
      );
    }
    return { text: bullet.text, reason: `${bullet.verdict}: "${bullet.span}"` };
  }

  /**
   * Question-and-answer Markdown, following `cv-document.ts`'s convention so the same writers
   * can export it.
   *
   * An unanswerable question is rendered EXPLICITLY as unanswered rather than left as a bare
   * heading. A silent gap would be discovered by the user on the employer's own form.
   */
  private buildScreeningMarkdown(answers: ScreeningAnswer[]): string {
    const parts: string[] = ['# Screening Answers'];

    for (const answer of answers) {
      parts.push(`## ${answer.question}`);
      if (answer.paragraphs.length === 0) {
        parts.push(
          '_No grounded answer: your CV contains no fact that supports one. ' +
            'Add the relevant experience to your master CV, or answer this one yourself._',
        );
        continue;
      }
      parts.push(...answer.paragraphs.map((p) => p.text));
    }

    return parts.join('\n\n');
  }

  private contactLine(masterMarkdown: string): string | null {
    const parts = extractContactLines(masterMarkdown);
    return parts.length > 0 ? parts.join(' | ') : null;
  }

  private async persist(
    context: { application: CvApplicationEntity; snapshot: FactSnapshot[]; kind: SupplementKind; revisionNo: number; idempotencyKey: string },
    content: string,
    provenance: SupplementProvenance,
    drafted: { modelUsed: string; promptVersion: string },
    validated: { validatorModelUsed: string; validatorPromptVersion: string },
  ): Promise<CvSupplementEntity> {
    const draft = {
      applicationId: context.application.id,
      kind: context.kind,
      revisionNo: context.revisionNo,
      content,
      factsSnapshot: context.snapshot,
      provenance,
      aiTellScore: scoreAiTell(content).score,
      modelUsed: drafted.modelUsed,
      promptVersion: drafted.promptVersion,
      validatorModelUsed: validated.validatorModelUsed,
      validatorPromptVersion: validated.validatorPromptVersion,
      idempotencyKey: context.idempotencyKey,
    } as unknown as CvSupplementEntity;

    const saved = await this.supplements.save(draft);

    // The application's `state` is deliberately NOT touched. A supplement is an accompanying
    // artefact, not a step in the CV state machine; advancing it from here would corrupt a
    // machine Phases 4 and 5 built guards around.
    this.logger.log(
      `supplement ${saved.id} (${context.kind} revision ${context.revisionNo}) for application ` +
        `${context.application.id}: ${provenance.paragraphs.length} paragraphs, ` +
        `${provenance.droppedParagraphs.length} dropped, model=${drafted.modelUsed} ` +
        `validator=${validated.validatorModelUsed}`,
    );

    return saved;
  }

  private async findOwned(userId: string, applicationId: string): Promise<CvApplicationEntity> {
    // Scoped by userId so another tenant's application is indistinguishable from a missing one.
    const application = await this.applications.findOne({ where: { id: applicationId, userId } });
    if (!application) {
      throw new NotFoundException(`application ${applicationId} not found`);
    }
    return application;
  }
}
