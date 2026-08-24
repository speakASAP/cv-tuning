import { Module } from '@nestjs/common';
import { BpcpClientService, BPCP_SERVICE_URL } from './bpcp-client.service';

@Module({
  providers: [
    BpcpClientService,
    { provide: BPCP_SERVICE_URL, useFactory: () => process.env.CV_BPCP_SERVICE_URL },
  ],
  exports: [BpcpClientService],
})
export class BpcpModule {}
