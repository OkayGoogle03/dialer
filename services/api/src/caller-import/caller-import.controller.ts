import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { uuidSchema, z, ZodPipe } from '../master-data/common';
import { CallerImportService } from './caller-import.service';
import { MAX_FILE_BYTES, TEMPLATE_FILENAME, XLSX_MIME } from './excel-format';

const keys = z.array(z.string().max(200)).max(5000);
const approveSchema = z.object({
  batchId: uuidSchema,
  approve: z.object({ processes: keys.default([]), providers: keys.default([]), callServers: keys.default([]), dids: keys.default([]), links: z.boolean().default(true) }).strict(),
}).strict();
const confirmSchema = z.object({ batchId: uuidSchema, mode: z.enum(['valid_only', 'strict']) }).strict();
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0), status: z.string().max(24).optional() }).strict();

@ApiTags('caller-import')
@ApiBearerAuth()
@RequirePermissions('caller_import:manage')
@Controller({ path: 'caller-import', version: '1' })
export class CallerImportController {
  constructor(private readonly service: CallerImportService) {}

  private async sendTemplate(u: AuthUser, res: Response) {
    const buf = await this.service.template(u);
    res.set({ 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="${TEMPLATE_FILENAME}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(buf);
  }

  @Post('template') @HttpCode(200)
  templatePost(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) { return this.sendTemplate(u, res); }

  @Get('template')
  templateGet(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) { return this.sendTemplate(u, res); }

  @Post('preview') @HttpCode(200) @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 } }))
  preview(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @ReqContext() ctx: RequestContext) {
    if (!file) throw new BadRequestException('Attach the Excel file in the "file" form field.');
    return this.service.preview(u, file, ctx);
  }

  @Post('approve-master-data') @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Body(new ZodPipe(approveSchema)) dto: z.infer<typeof approveSchema>, @ReqContext() ctx: RequestContext) {
    return this.service.approve(u, dto.batchId, dto.approve, ctx);
  }

  @Post('confirm') @HttpCode(200)
  confirm(@CurrentUser() u: AuthUser, @Body(new ZodPipe(confirmSchema)) dto: z.infer<typeof confirmSchema>, @ReqContext() ctx: RequestContext) {
    return this.service.confirm(u, dto.batchId, dto.mode, ctx);
  }

  @Get('batches')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(pageSchema)) q: z.infer<typeof pageSchema>) { return this.service.listBatches(u, { ...q, limit: Math.min(q.limit, 100) }); }

  @Get('batches/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.service.getBatch(u, id); }

  @Get('batches/:id/records')
  records(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(pageSchema)) q: z.infer<typeof pageSchema>) { return this.service.batchRecords(u, id, q); }

  @Get('batches/:id/errors')
  errors(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(pageSchema)) q: z.infer<typeof pageSchema>) { return this.service.batchErrors(u, id, q); }

  @Get('batches/:id/download-errors')
  async download(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { csv, filename } = await this.service.errorReport(u, id);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(Buffer.from(csv, 'utf8'));
  }

  @Delete('batches/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) { return this.service.remove(u, id, ctx); }
}
