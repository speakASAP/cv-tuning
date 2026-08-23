import { Body, Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { ImportGdocsDto } from './dto/import-gdocs.dto';
import { SaveMasterDto } from './dto/save-master.dto';
import { GdocsImporter } from './importers/gdocs.importer';
import { MasterCvService } from './master-cv.service';

interface AuthedRequest {
  user: CvUser;
}

@Controller('api/master')
@UseGuards(CvAuthGuard)
export class MasterCvController {
  constructor(
    private readonly master: MasterCvService,
    private readonly gdocs: GdocsImporter,
  ) {}

  @Post()
  async save(@Req() req: AuthedRequest, @Body() body: SaveMasterDto) {
    // The user id always comes from the validated token, never from the body.
    return this.master.save(req.user.id, body.markdown, 'paste', undefined);
  }

  @Post('import/gdocs')
  async importGdocs(@Req() req: AuthedRequest, @Body() body: ImportGdocsDto) {
    const markdown = await this.gdocs.fetchMarkdown(body.url);
    return this.master.save(req.user.id, markdown, 'gdocs', body.url);
  }

  @Get()
  async getCurrent(@Req() req: AuthedRequest) {
    const current = await this.master.getCurrent(req.user.id);
    if (!current) {
      throw new NotFoundException('no master CV for this user yet');
    }
    return current;
  }

  @Get('facts')
  async getFacts(@Req() req: AuthedRequest) {
    const current = await this.master.getCurrent(req.user.id);
    if (!current) {
      throw new NotFoundException('no master CV for this user yet');
    }
    return current.facts;
  }
}
