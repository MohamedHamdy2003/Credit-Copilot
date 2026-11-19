import 'reflect-metadata';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Body,
  Param,
  Inject,
  Module,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type ExceptionFilter,
  type ArgumentsHost,
  Catch,
  HttpException,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, ApiBody, ApiCookieAuth, ApiHeader } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import type { AuthService } from '../../../packages/application/src/auth.js';
import type { DecisionService } from '../../../packages/application/src/decisions.js';
import type { Actor } from '../../../packages/domain/src/access.js';
import { DomainError, invariant } from '../../../packages/domain/src/errors.js';

const AUTH = Symbol('AUTH'),
  DECISIONS = Symbol('DECISIONS');
interface AuthRequest extends Request {
  actor: Actor;
  csrf: string;
  requestId: string;
}
class SessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = (request.cookies as Record<string, string> | undefined)?.copilot_session;
    const session = await this.auth.authenticate(token);
    request.actor = session.actor;
    request.csrf = session.csrf;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      invariant(
        typeof csrf === 'string' &&
          /^[a-f0-9]{64}$/.test(csrf) &&
          timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf)),
        'InvalidCsrfToken',
        'Valid CSRF header required',
        403,
      );
    }
    return true;
  }
}
@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp(),
      req = context.getRequest<AuthRequest>(),
      response = context.getResponse<Response>();
    const parserError =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      (error.type === 'entity.parse.failed' || error.type === 'entity.too.large');
    const status =
      error instanceof DomainError
        ? error.status
        : error instanceof ZodError
          ? 422
          : error instanceof HttpException
            ? error.getStatus()
            : parserError
              ? 'type' in error && error.type === 'entity.too.large'
                ? 413
                : 400
              : 500;
    response.status(status).json({
      error: {
        code:
          error instanceof DomainError
            ? error.code
            : error instanceof ZodError
              ? 'InvalidRequest'
              : status === 404
                ? 'NotFound'
                : status === 413
                  ? 'PayloadTooLarge'
                  : status < 500
                    ? 'InvalidRequest'
                    : 'InternalError',
        message:
          error instanceof DomainError
            ? error.message
            : error instanceof ZodError
              ? 'Request does not match the schema'
              : status < 500
                ? 'Request could not be processed'
                : 'Unexpected server error',
      },
      requestId: req.requestId,
    });
  }
}
export async function createApi(deps: {
  auth: AuthService;
  decisions: DecisionService;
  webOrigin: string;
  secureCookies: boolean;
  sessionHours: number;
}) {
  const cookie = {
    httpOnly: true,
    secure: deps.secureCookies,
    sameSite: 'strict' as const,
    path: '/api',
    maxAge: deps.sessionHours * 3600000,
  };
  @Controller('auth')
  class AuthController {
    constructor(@Inject(AUTH) private readonly auth: AuthService) {}
    @Post('login')
    @ApiBody({
      schema: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
          username: { type: 'string' },
          password: { type: 'string', format: 'password' },
        },
      },
    })
    async login(
      @Body() body: unknown,
      @Req() req: AuthRequest,
      @Res({ passthrough: true }) res: Response,
    ) {
      const input = z
        .object({
          username: z.string().trim().min(1).max(100),
          password: z.string().min(1).max(256),
        })
        .strict()
        .parse(body);
      const session = await this.auth.login(input.username, input.password, req.ip ?? 'unknown');
      res.cookie('copilot_session', session.token, cookie);
      return { user: session.actor, csrfToken: session.csrf, requestId: req.requestId };
    }
    @Get('me')
    @UseGuards(SessionGuard)
    @ApiCookieAuth()
    me(@Req() req: AuthRequest) {
      return { user: req.actor, csrfToken: req.csrf };
    }
    @Post('logout')
    @UseGuards(SessionGuard)
    @ApiCookieAuth()
    @ApiHeader({ name: 'x-csrf-token', required: true })
    async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
      await this.auth.logout((req.cookies as Record<string, string>).copilot_session!);
      res.clearCookie('copilot_session', { ...cookie, maxAge: undefined });
      return { status: 'logged_out' };
    }
  }
  @Controller()
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  class ReviewController {
    constructor(@Inject(DECISIONS) private readonly decisions: DecisionService) {}
    @Get('reviews') queue(@Req() req: AuthRequest) {
      return this.decisions.queue(req.actor);
    }
    @Get('assessments/:id') read(@Param('id') id: string, @Req() req: AuthRequest) {
      return this.decisions.read(req.actor, id);
    }
    @Post('assessments/:id/decisions')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiBody({
      schema: {
        type: 'object',
        required: ['action', 'expectedVersion', 'comment'],
        properties: {
          action: { type: 'string', enum: ['approve', 'reject', 'customer_response', 'issue'] },
          expectedVersion: { type: 'integer', minimum: 1 },
          comment: { type: 'string' },
          clause: { type: 'string' },
          accepted: { type: 'boolean' },
          disbursementDate: { type: 'string', format: 'date' },
        },
      },
    })
    decide(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
      return this.decisions.execute(req.actor, id, body, req.requestId);
    }
  }
  @Controller('health')
  class HealthController {
    @Get() health() {
      return { service: 'credit-copilot', status: 'ok' };
    }
  }
  @Module({
    controllers: [AuthController, ReviewController, HealthController],
    providers: [
      SessionGuard,
      { provide: AUTH, useValue: deps.auth },
      { provide: DECISIONS, useValue: deps.decisions },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bodyParser: false,
  });
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: AuthRequest, res: Response, next: () => void) => {
    req.requestId = randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && origin !== deps.webOrigin) {
      res.status(403).json({
        error: { code: 'OriginNotAllowed', message: 'Origin not permitted' },
        requestId: req.requestId,
      });
      return;
    }
    next();
  });
  app.useBodyParser('json', { limit: '16kb' });
  app.enableCors({
    origin: deps.webOrigin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'x-csrf-token'],
  });
  app.useGlobalFilters(new ApiErrors());
  app.setGlobalPrefix('api/v1');
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Credit Copilot')
        .setVersion('0.2.0')
        .addCookieAuth('copilot_session')
        .build(),
    ),
  );
  return app;
}
