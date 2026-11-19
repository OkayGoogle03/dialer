import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, AppConfig } from '../config/env';

/** Non-secret application info for signed-in users (currently: where to download the Windows desktop app). */
@ApiTags('app')
@ApiBearerAuth()
@Controller({ path: 'app', version: '1' })
export class AppInfoController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('desktop')
  desktop() {
    return { available: !!this.config.desktopDownloadUrl, url: this.config.desktopDownloadUrl || null, version: this.config.desktopVersion || null };
  }
}
