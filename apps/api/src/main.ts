import 'reflect-metadata';
import 'dotenv/config';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { service: 'credit-copilot', status: 'ok' };
  }
}
@Module({ controllers: [HealthController] })
class AppModule {}

const app = await NestFactory.create(AppModule);
app.use(helmet());
app.setGlobalPrefix('api/v1');
const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle('Credit Copilot').setVersion('0.1.0').build(),
);
SwaggerModule.setup('api/docs', app, document);
await app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
