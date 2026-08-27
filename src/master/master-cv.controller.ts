import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { ConsentGuard } from './consent.guard';
import { ImportGdocsDto } from './dto/import-gdocs.dto';
import { SaveMasterDto } from './dto/save-master.dto';
import { MinioService } from '../storage/minio.service';
import { DocumentImporter } from './importers/document.importer';
import { GdocsImporter } from './importers/gdocs.importer';
import { LinkedinImporter } from './importers/linkedin.importer';
import { MasterCvService } from './master-cv.service';
import { ConsentService } from './consent.service';

interface AuthedRequest {
  user: CvUser;
}

interface UploadedDocument {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/** Large enough for any real CV, small enough that a bad upload cannot exhaust memory. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ZIP_MIMES = ['application/zip', 'application/x-zip-compressed'];

@Controller('api/master')
@UseGuards(CvAuthGuard)
export class MasterCvController {
  constructor(
    private readonly master: MasterCvService,
    private readonly gdocs: GdocsImporter,
    private readonly documents: DocumentImporter,
    private readonly linkedin: LinkedinImporter,
    private readonly storage: MinioService,
    private readonly consent: ConsentService,
  ) {}

  @Post()
  @UseGuards(ConsentGuard)
  async save(@Req() req: AuthedRequest, @Body() body: SaveMasterDto) {
    // The user id always comes from the validated token, never from the body.
    return this.master.save(req.user.id, body.markdown, 'paste', undefined);
  }

  @Post('import/gdocs')
  @UseGuards(ConsentGuard)
  async importGdocs(@Req() req: AuthedRequest, @Body() body: ImportGdocsDto) {
    const markdown = await this.gdocs.fetchMarkdown(body.url);
    return this.master.save(req.user.id, markdown, 'gdocs', body.url);
  }

  @Post('import/upload')
  @UseGuards(ConsentGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async importUpload(@Req() req: AuthedRequest, @UploadedFile() file?: UploadedDocument) {
    if (!file) {
      throw new BadRequestException('no file was uploaded');
    }

    const isZip = ZIP_MIMES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (!isZip && !DocumentImporter.isSupported(file.mimetype)) {
      throw new BadRequestException(
        `unsupported file type ${file.mimetype}. Upload a PDF, DOCX, plain text, or a LinkedIn export zip.`,
      );
    }

    // Store the original before parsing: if extraction fails we still hold what the user
    // sent, which is what makes the failure diagnosable rather than just reported.
    const extension = isZip ? 'zip' : DocumentImporter.extensionFor(file.mimetype);
    const key = `${req.user.id}/${randomUUID()}.${extension}`;
    await this.storage.putObject(key, file.buffer, file.mimetype);

    if (isZip) {
      const AdmZip = (await import('adm-zip')).default;
      const markdown = this.linkedin.toMarkdown(new AdmZip(file.buffer));
      return this.master.save(req.user.id, markdown, 'linkedin', key);
    }

    const markdown = await this.documents.extract(file.buffer, file.mimetype);
    return this.master.save(req.user.id, markdown, 'upload', key);
  }

  @Get()
  async getCurrent(@Req() req: AuthedRequest) {
    const current = await this.master.getCurrent(req.user.id);
    if (!current) {
      throw new NotFoundException('no master CV for this user yet');
    }
    return current;
  }

  @Get('consent')
  async getConsent(@Req() req: AuthedRequest) {
    return this.consent.get(req.user.id);
  }

  @Post('consent')
  async grantConsent(@Req() req: AuthedRequest) {
    return this.consent.grant(req.user.id);
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
