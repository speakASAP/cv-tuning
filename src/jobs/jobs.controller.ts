import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { ConsentGuard } from '../master/consent.guard';
import { PasteJobDto } from './dto/paste-job.dto';
import { SubmitJobDto } from './dto/submit-job.dto';
import { SupplyTextDto } from './dto/supply-text.dto';
import { JobsService } from './jobs.service';

interface AuthedRequest {
  user: CvUser;
}

@Controller('api/jobs')
@UseGuards(CvAuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  async submit(@Req() req: AuthedRequest, @Body() body: SubmitJobDto) {
    // The user id always comes from the validated token, never from the body.
    return this.jobs.submitUrl(req.user.id, body.url);
  }

  @Post('text')
  async paste(@Req() req: AuthedRequest, @Body() body: PasteJobDto) {
    return this.jobs.submitText(req.user.id, body.text, body.url);
  }

  @Post(':id/text')
  async supplyText(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SupplyTextDto,
  ) {
    return this.jobs.supplyText(req.user.id, id, body.text);
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    return this.jobs.list(req.user.id);
  }

  @Get(':id')
  async get(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(req.user.id, id);
  }

  @Post(':id/score')
  @UseGuards(ConsentGuard)
  async score(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.score(req.user.id, id);
  }
}
