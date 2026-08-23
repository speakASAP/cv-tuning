import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { ApplicationsService } from './applications.service';
import { ConfirmClaimDto } from './dto/confirm-claim.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ReviseDto } from './dto/revise.dto';

interface AuthedRequest {
  user: CvUser;
}

@Controller('api/applications')
@UseGuards(CvAuthGuard)
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

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
    return this.applications.confirmClaim(req.user.id, id, revisionNo, body.bulletText, body.decision);
  }

  @Post(':id/approve')
  async approve(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.applications.approve(req.user.id, id);
  }
}
