import { Module } from '@nestjs/common';
import { CvDocxService } from './cv-docx.service';
import { CvPdfService } from './cv-pdf.service';

@Module({
  providers: [CvPdfService, CvDocxService],
  exports: [CvPdfService, CvDocxService],
})
export class ExportModule {}
