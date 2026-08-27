import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { ApplicationsService } from './applications.service';
import { SupplementsService } from './supplements.service';
import { GenerateCoverLetterDto } from './dto/generate-cover-letter.dto';
import { GenerateScreeningDto } from './dto/generate-screening.dto';
import { SUPPLEMENT_KINDS, SupplementKind } from './supplement.types';
import { ConfirmClaimDto } from './dto/confirm-claim.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { MarkSentDto } from './dto/mark-sent.dto';
import { RecordOutcomeDto } from './dto/record-outcome.dto';
import { ReviseDto } from './dto/revise.dto';

interface AuthedRequest {
  user: CvUser;
}

@Controller('api/applications')
@UseGuards(CvAuthGuard)
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService,
    private readonly supplements: SupplementsService,
  ) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: CreateApplicationDto) {
    // The user id always comes from the validated token, never from the body.
    return this.applications.create(req.user.id, body.jobId, body.renderLanguage);
  }

  @Post(':id/regenerate')
  async regenerate(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.regenerate(req.user.id, id);
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.applications.list(req.user.id);
  }

  @Get(':id')
  async get(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.get(req.user.id, id);
  }

  @Get(':id/renders')
  async listRenders(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.listRenders(req.user.id, id);
  }

  @Get(':id/renders/:revisionNo/diff')
  async diff(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNo', ParseIntPipe) revisionNo: number,
  ) {
    return this.applications.diff(req.user.id, id, revisionNo);
  }

  @Post(':id/revise')
  async revise(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviseDto,
  ) {
    return this.applications.revise(req.user.id, id, body.instruction, body.inputMode);
  }

  @Get(':id/chat')
  async chat(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.listChat(req.user.id, id);
  }

  @Post(':id/renders/:revisionNo/confirm-claim')
  async confirmClaim(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNo', ParseIntPipe) revisionNo: number,
    @Body() body: ConfirmClaimDto,
  ) {
    return this.applications.confirmClaim(req.user.id, id, revisionNo, body.bulletId, body.decision);
  }

  @Post(':id/approve')
  async approve(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.approve(req.user.id, id);
  }

  /**
   * Completes an approval whose export failed. Deliberately NOT folded into `approve` — see
   * `ApplicationsService.retryExport` for why the approval guard stays absolute.
   */
  @Post(':id/retry-export')
  async retryExport(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.retryExport(req.user.id, id);
  }

  /**
   * Spec §5. User-asserted submission — the app cannot observe a send on a third-party portal.
   */
  @Post(':id/mark-sent')
  async markSent(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkSentDto,
  ) {
    return this.applications.markSent(
      req.user.id,
      id,
      body.sentAt ? new Date(body.sentAt) : undefined,
    );
  }

  @Post(':id/outcome')
  async recordOutcome(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecordOutcomeDto,
  ) {
    return this.applications.recordOutcome(req.user.id, id, body.outcome);
  }

  @Get(':id/renders/:revisionNo/download/:kind')
  async download(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionNo', ParseIntPipe) revisionNo: number,
    @Param('kind') kind: string,
    @Res() res: Response,
  ) {
    if (kind !== 'pdf' && kind !== 'docx') {
      throw new BadRequestException(`unknown artifact kind "${kind}"`);
    }
    const { content, artifact } = await this.applications.download(req.user.id, id, revisionNo, kind);
    res.setHeader(
      'content-type',
      kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('content-disposition', `attachment; filename="cv-r${revisionNo}.${kind}"`);
    res.setHeader('content-length', String(artifact.byteSize));
    res.send(content);
  }

  @Post(':id/cover-letter')
  async generateCoverLetter(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GenerateCoverLetterDto,
  ) {
    return this.supplements.generateCoverLetter(req.user.id, id, body);
  }

  @Post(':id/screening')
  async generateScreening(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GenerateScreeningDto,
  ) {
    return this.supplements.generateScreening(req.user.id, id, body);
  }

  @Get(':id/supplements')
  async listSupplements(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.supplements.list(req.user.id, id);
  }

  @Get(':id/supplements/:kind/:revisionNo')
  async getSupplement(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Param('revisionNo') revisionNo: string,
  ) {
    return this.supplements.get(
      req.user.id,
      id,
      assertSupplementKind(kind),
      assertRevisionNo(revisionNo),
    );
  }

  @Get(':id/supplements/:kind/:revisionNo/download/:artifactKind')
  async downloadSupplement(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Param('revisionNo') revisionNo: string,
    @Param('artifactKind') artifactKind: string,
    @Res() res: Response,
  ) {
    if (artifactKind !== 'pdf' && artifactKind !== 'docx') {
      throw new BadRequestException(`unknown artifact kind "${artifactKind}"`);
    }
    const { content, artifact } = await this.supplements.export(
      req.user.id,
      id,
      assertSupplementKind(kind),
      assertRevisionNo(revisionNo),
      artifactKind,
    );
    res.setHeader(
      'content-type',
      artifactKind === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader(
      'content-disposition',
      `attachment; filename="${kind}-r${revisionNo}.${artifactKind}"`,
    );
    res.setHeader('content-length', String(artifact.byteSize));
    res.send(content);
  }
}

/**
 * Validated BEFORE the lookup, and by hand rather than by `ParseIntPipe`.
 *
 * Recorded trap: `cv_application.id` is a uuid column, and a malformed path segment that
 * reaches Postgres surfaces as a bare 500 — which callers classify as transient and RETRY,
 * turning one bad request into a retry storm against the database. A malformed request must
 * stay a permanent 4xx.
 */
function assertSupplementKind(kind: string): SupplementKind {
  if (!(SUPPLEMENT_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException(
      `unknown supplement kind "${kind}"; expected one of ${SUPPLEMENT_KINDS.join(', ')}`,
    );
  }
  return kind as SupplementKind;
}

function assertRevisionNo(value: string): number {
  // `ParseIntPipe` accepts "1.5" and "1e3". A revision is a positive integer or it is a 400.
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BadRequestException(`revision must be a positive integer, got "${value}"`);
  }
  return Number(value);
}
