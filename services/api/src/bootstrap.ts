import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppDeps, createAppModule } from './app.module';
import { PinoNestLogger } from './common/logging/logger';

export async function createApp(deps: AppDeps): Promise<INestApplication> {
  const app = await NestFactory.create(createAppModule(deps), { logger: new PinoNestLogger(deps.logger) });
  app.use(helmet());
  // Trust exactly one proxy hop (ingress) so req.ip is the client IP. Adjust per deployment.
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors({ origin: deps.config.corsOrigins, credentials: true, exposedHeaders: ['X-Correlation-Id'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  if (deps.config.nodeEnv !== 'production') {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Project Dialer API').setVersion('1.0').addBearerAuth().build());
    SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}
