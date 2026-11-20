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
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Headers,
  HttpCode,
  type CanActivate,
  type ExecutionContext,
  type ExceptionFilter,
  type ArgumentsHost,
  Catch,
  HttpException,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiConsumes,
  ApiProduces,
  ApiAcceptedResponse,
  ApiOkResponse,
  type SchemaObject,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import type { AuthService } from '../../../packages/application/src/auth.js';
import type { DecisionService } from '../../../packages/application/src/decisions.js';
import type { Actor } from '../../../packages/domain/src/access.js';
import { DomainError, invariant } from '../../../packages/domain/src/errors.js';
import type { OperationsService } from '../../../packages/application/src/operations.js';
import type { CaseReviewService } from '../../../packages/application/src/case-review.js';
import { sendEventStream } from './sse.js';

const AUTH = Symbol('AUTH'),
  DECISIONS = Symbol('DECISIONS');
const OPERATIONS = Symbol('OPERATIONS');
const CASE_REVIEWS = Symbol('CASE_REVIEWS');
const questionRequestBody: SchemaObject = {
  type: 'object',
  required: ['question'],
  additionalProperties: false,
  properties: {
    question: { type: 'string', maxLength: 2000 },
    asOfDate: { type: 'string', format: 'date' },
    product: { type: 'string', enum: ['PL-100'] },
    edition: { type: 'string', enum: ['CP-2024', 'CP-2025'] },
  },
};
const assessmentRequestBody: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: { mode: { type: 'string', enum: ['strict', 'demo'] } },
};
interface MemoryUpload {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}
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
class IngestionGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    invariant(
      context.switchToHttp().getRequest<AuthRequest>().actor.canIngest,
      'Forbidden',
      'Knowledge ingestion permission required',
      403,
    );
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
  operations?: OperationsService;
  maxUploadBytes?: number;
  caseReviews?: CaseReviewService;
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
  @Controller()
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  class CaseReviewController {
    constructor(@Inject(CASE_REVIEWS) private readonly reviews: CaseReviewService | null) {}
    private service() {
      invariant(this.reviews, 'ServiceUnavailable', 'Case review service unavailable', 503);
      return this.reviews;
    }
    @Get('assessments/:id/written-reason') reason(
      @Param('id') id: string,
      @Req() req: AuthRequest,
    ) {
      return this.service().reason(req.actor, id);
    }
    @Post('assessments/:id/reason-requests')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiBody({
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', maxLength: 2000 } },
      },
    })
    requestReason(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
      return this.service().requestReason(req.actor, id, body ?? {}, req.requestId);
    }
    @Get('referrals') referrals(@Req() req: AuthRequest) {
      return this.service().referrals(req.actor);
    }
    @Get('referrals/:id') referral(@Param('id') id: string, @Req() req: AuthRequest) {
      return this.service().referral(req.actor, id);
    }
    @Post('referrals/:id/reviews')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiBody({
      schema: {
        type: 'object',
        required: ['expectedVersion', 'action', 'comment'],
        additionalProperties: false,
        properties: {
          expectedVersion: { type: 'integer', minimum: 1 },
          action: {
            type: 'string',
            enum: ['awaiting_evidence', 'requires_reassessment', 'fraud_recorded'],
          },
          comment: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    })
    note(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthRequest) {
      return this.service().note(req.actor, id, body, req.requestId);
    }
  }
  @Controller()
  @UseGuards(SessionGuard)
  @ApiCookieAuth()
  class OperationsController {
    constructor(@Inject(OPERATIONS) private readonly operations: OperationsService | null) {}
    private service() {
      invariant(this.operations, 'ServiceUnavailable', 'Core operations not configured', 503);
      return this.operations;
    }
    @Get('knowledge/documents') documents() {
      return this.service().documents();
    }
    @Get('knowledge/ingestions') attempts(@Req() req: AuthRequest) {
      return this.service().attempts(req.actor);
    }
    @Post('knowledge/ingestions')
    @ApiConsumes('multipart/form-data')
    @UseGuards(IngestionGuard)
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @UseInterceptors(
      FilesInterceptor('files', 20, {
        limits: { fileSize: deps.maxUploadBytes ?? 10485760, files: 20, fields: 0 },
      }),
    )
    @ApiBody({
      schema: {
        type: 'object',
        required: ['files'],
        properties: {
          files: { type: 'array', maxItems: 20, items: { type: 'string', format: 'binary' } },
        },
      },
    })
    ingest(@UploadedFiles() files: MemoryUpload[] | undefined, @Req() req: AuthRequest) {
      return this.service().ingest(
        req.actor,
        (files ?? []).map((f) => ({ filename: f.originalname, bytes: f.buffer, mime: f.mimetype })),
      );
    }
    @Post('questions')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiBody({ schema: questionRequestBody })
    question(@Body() body: unknown) {
      return this.service().question(body);
    }
    @Post('questions/streams')
    @HttpCode(202)
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiHeader({ name: 'Idempotency-Key', required: true })
    @ApiBody({ schema: questionRequestBody })
    @ApiAcceptedResponse({
      schema: {
        type: 'object',
        required: ['streamId'],
        properties: { streamId: { type: 'string', format: 'uuid' } },
      },
    })
    startQuestionStream(
      @Body() body: unknown,
      @Headers('idempotency-key') key: unknown,
      @Req() req: AuthRequest,
    ) {
      return this.service().startQuestionStream(req.actor, body, key);
    }
    @Get('question-streams/:id')
    @ApiProduces('text/event-stream')
    @ApiHeader({ name: 'Last-Event-ID', required: false })
    @ApiOkResponse({
      description: 'Verified citation excerpts followed by a terminal event',
      schema: { type: 'string' },
    })
    questionStream(
      @Param('id') id: string,
      @Headers('last-event-id') cursor: unknown,
      @Req() req: AuthRequest,
      @Res() res: Response,
    ) {
      return sendEventStream(
        res,
        cursor,
        () => this.service().questionEvents(req.actor, id),
        () => deps.auth.authenticate(req.cookies?.copilot_session),
      );
    }
    @Post('calculations')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiBody({
      schema: {
        type: 'object',
        required: ['principal', 'income', 'obligations', 'months', 'date'],
        additionalProperties: false,
        properties: {
          principal: { type: 'string' },
          income: { type: 'string' },
          obligations: { type: 'string' },
          months: { type: 'integer' },
          date: { type: 'string', format: 'date' },
          payroll: { type: 'boolean' },
        },
      },
    })
    calculate(@Body() body: unknown) {
      return this.service().calculate(body);
    }
    @Get('applications/fixtures') fixtures() {
      return this.service().fixtures();
    }
    @Get('applications') list(@Req() req: AuthRequest) {
      return this.service().list(req.actor);
    }
    @Post('applications')
    @ApiConsumes('multipart/form-data')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @UseInterceptors(
      FileInterceptor('file', {
        limits: { fileSize: deps.maxUploadBytes ?? 10485760, files: 1, fields: 0 },
      }),
    )
    @ApiBody({
      schema: {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string', format: 'binary' } },
      },
    })
    upload(@UploadedFile() file: MemoryUpload | undefined, @Req() req: AuthRequest) {
      invariant(file, 'InvalidUpload', 'Application file required');
      return this.service().upload(req.actor, {
        filename: file.originalname,
        bytes: file.buffer,
        mime: file.mimetype,
      });
    }
    @Post('applications/fixtures/:reference')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    select(@Param('reference') reference: string, @Body() body: unknown, @Req() req: AuthRequest) {
      z.object({})
        .strict()
        .parse(body ?? {});
      return this.service().selectFixture(req.actor, reference);
    }
    @Get('applications/:id') read(@Param('id') id: string, @Req() req: AuthRequest) {
      return this.service().read(req.actor, id);
    }
    @Post('applications/:id/assessments')
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiHeader({ name: 'Idempotency-Key', required: false })
    @ApiBody({ schema: assessmentRequestBody })
    assess(
      @Param('id') id: string,
      @Body() body: unknown,
      @Headers('idempotency-key') key: string | undefined,
      @Req() req: AuthRequest,
    ) {
      return this.service().assess(req.actor, id, body ?? {}, req.requestId, key);
    }
    @Post('applications/:id/assessment-streams')
    @HttpCode(202)
    @ApiHeader({ name: 'x-csrf-token', required: true })
    @ApiHeader({ name: 'Idempotency-Key', required: true })
    @ApiBody({ schema: assessmentRequestBody })
    @ApiAcceptedResponse({
      schema: {
        type: 'object',
        required: ['runId'],
        properties: { runId: { type: 'string', format: 'uuid' } },
      },
    })
    startAssessmentStream(
      @Param('id') id: string,
      @Body() body: unknown,
      @Headers('idempotency-key') key: unknown,
      @Req() req: AuthRequest,
    ) {
      return this.service().startAssessmentStream(req.actor, id, body ?? {}, req.requestId, key);
    }
    @Get('assessment-streams/:id')
    @ApiProduces('text/event-stream')
    @ApiHeader({ name: 'Last-Event-ID', required: false })
    @ApiOkResponse({
      description: 'Assessment stages followed by a terminal event',
      schema: { type: 'string' },
    })
    assessmentStream(
      @Param('id') id: string,
      @Headers('last-event-id') cursor: unknown,
      @Req() req: AuthRequest,
      @Res() res: Response,
    ) {
      return sendEventStream(
        res,
        cursor,
        () => this.service().assessmentEvents(req.actor, id),
        () => deps.auth.authenticate(req.cookies?.copilot_session),
      );
    }
    @Get('applications/:id/evidence') async evidence(
      @Param('id') id: string,
      @Req() req: AuthRequest,
      @Res() res: Response,
    ) {
      const original = await this.service().evidence(req.actor, id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(original.filename)}`,
      );
      res.send(Buffer.from(original.bytes));
    }
    @Get('offers/:id') offer(@Param('id') id: string, @Req() req: AuthRequest) {
      return this.service().offer(req.actor, id);
    }
  }
  @Controller('health')
  class HealthController {
    @Get() health() {
      return { service: 'credit-copilot', status: 'ok' };
    }
  }
  @Module({
    controllers: [
      AuthController,
      ReviewController,
      CaseReviewController,
      OperationsController,
      HealthController,
    ],
    providers: [
      SessionGuard,
      IngestionGuard,
      { provide: AUTH, useValue: deps.auth },
      { provide: DECISIONS, useValue: deps.decisions },
      { provide: OPERATIONS, useValue: deps.operations ?? null },
      { provide: CASE_REVIEWS, useValue: deps.caseReviews ?? null },
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
    allowedHeaders: ['Content-Type', 'x-csrf-token', 'Idempotency-Key', 'Last-Event-ID'],
    exposedHeaders: ['x-request-id', 'Content-Disposition'],
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
