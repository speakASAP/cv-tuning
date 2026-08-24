import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { CvAuthGuard, CvUser } from '../auth/cv-auth.guard';
import { DashboardService } from './dashboard.service';

@Controller('api/dashboard')
@UseGuards(CvAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  async summary(@Req() req: { user: CvUser }) {
    // The user id always comes from the validated token; there is no path to another user's funnel.
    return this.dashboard.summary(req.user.id);
  }
}
