import { createHash, randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import {
  FeedbackRequestSchema,
  SaveSummaryRequestSchema,
  ShareRequestSchema,
  SummarizeRequestSchema,
} from "@notach/shared";
import type { SummarizationLimits, SummaryContent } from "@notach/shared";
import {
  AppError,
  type NoteRepository,
  type SummarizationPort,
  type SummarySaveMetadata,
  type TokenVerifier,
} from "./domain.js";
import { normalizeProviderError } from "./services/provider-errors.js";
import { getSummaryModelCatalog } from "./config/models.js";
import { HourlyBudget } from "./services/ai-budget.js";
import { costNanoUsd, getModelPricing } from "./config/pricing.js";

interface AppConfig {
  corsOrigins: string[];
  maxNoteChars: number;
  modelId: string;
  promptVersion: string;
  provider: "mock" | "gemini";
}

interface Dependencies {
  verifyToken: TokenVerifier;
  repository: NoteRepository;
  summarizer: SummarizationPort;
  budget: HourlyBudget;
  config: AppConfig;
  now?: () => number;
}

interface AuthenticatedRequest extends Request {
  authUser?: { uid: string };
  requestId?: string;
}

interface GenerationRecord {
  noteId: string;
  sourceRevision: number;
  modelId: string;
  promptVersion: string;
  durationMs: number;
  expiresAt: number;
}

interface GenerationResult {
  noteId: string;
  sourceRevision: number;
  requestId: string;
  summary: SummaryContent;
  modelId: string;
  promptVersion: string;
  durationMs: number;
  outdated: boolean;
  saved: boolean;
  summaryId?: string;
}

interface PendingGeneration {
  noteId: string;
  requestId: string;
  controller: AbortController;
  fingerprint: string;
  result: Promise<GenerationResult>;
}

const GENERATION_DEADLINE_MS = 600_000;

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value)
    throw new AppError(
      400,
      "INVALID_ROUTE_PARAMETER",
      "Некоректний ідентифікатор запиту.",
    );
  return value;
}

export function createApp(dependencies: Dependencies) {
  const { verifyToken, repository, summarizer, budget, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  const modelCatalog = getSummaryModelCatalog(config.provider, config.modelId);
  const app = express();
  const generations = new Map<string, GenerationRecord>();
  const inFlight = new Map<string, PendingGeneration>();

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: config.corsOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "768kb", strict: true }));
  app.use((req: AuthenticatedRequest, _res, next) => {
    req.requestId =
      typeof req.header("X-Request-Id") === "string"
        ? req.header("X-Request-Id")
        : randomUUID();
    next();
  });

  const authenticate = async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ) => {
    try {
      const authorization = req.header("Authorization");
      const match = authorization?.match(/^Bearer\s+(.+)$/i);
      if (!match)
        throw new AppError(
          401,
          "UNAUTHENTICATED",
          "Потрібно увійти до облікового запису.",
        );
      req.authUser = await verifyToken(match[1]!);
      next();
    } catch (error) {
      if (error instanceof AppError) return next(error);
      return next(
        new AppError(
          401,
          "UNAUTHENTICATED",
          "Сеанс завершився. Увійдіть знову.",
        ),
      );
    }
  };

  const getRole = async (noteId: string, uid: string) => {
    const note = await repository.getNote(noteId);
    if (!note)
      throw new AppError(404, "NOTE_NOT_FOUND", "Нотатку не знайдено.");
    const role = await repository.getRole(noteId, uid);
    if (!role)
      throw new AppError(404, "NOTE_NOT_FOUND", "Нотатку не знайдено.");
    return { note, role };
  };

  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      data: {
        status: "ok",
        version: "1.0.0",
        environment: config.provider === "mock" ? "mock" : "configured",
      },
    }),
  );

  app.get("/api/models", authenticate, (_req, res) => {
    res.json({ ok: true, data: modelCatalog });
  });

  app.get(
    "/api/summarization/limits",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const timestamp = now();
      const modelId = req.query.modelId ?? modelCatalog.defaultModelId;
      if (
        typeof modelId !== "string" ||
        !modelCatalog.models.some((model) => model.id === modelId)
      )
        throw new AppError(400, "INVALID_MODEL", "Оберіть доступну модель.");
      const data: SummarizationLimits = {
        provider: config.provider,
        serverTime: new Date(timestamp).toISOString(),
        budget: await budget.read(req.authUser!.uid),
        pricing:
          config.provider === "gemini"
            ? { modelId, ...getModelPricing(modelId, timestamp) }
            : null,
        text: { maxCharacters: config.maxNoteChars },
        generation: {
          deadlineSeconds: GENERATION_DEADLINE_MS / 1000,
          maxConcurrentPerNote: 1,
        },
        providerQuota: { available: false },
      };
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, data });
    },
  );

  app.post(
    "/api/notes/:noteId/generation/:requestId/cancel",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const requestId = routeParam(req, "requestId");
      const { role } = await getRole(noteId, req.authUser!.uid);
      if (role === "viewer")
        throw new AppError(403, "FORBIDDEN", "Недостатньо прав.");
      const cancelled = await repository.cancelGeneration(
        noteId,
        requestId,
        req.authUser!.uid,
      );
      for (const job of inFlight.values()) {
        if (cancelled && job.noteId === noteId && job.requestId === requestId)
          job.controller.abort();
      }
      res.json({ ok: true, data: { cancelled } });
    },
  );

  app.post(
    "/api/notes/:noteId/summaries/:summaryId/collaboration",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const summaryId = routeParam(req, "summaryId");
      const { role } = await getRole(noteId, req.authUser!.uid);
      if (role === "viewer")
        throw new AppError(403, "FORBIDDEN", "Недостатньо прав.");
      const state = (req.body as { state?: unknown }).state;
      if (
        state !== undefined &&
        (typeof state !== "string" ||
          state.length > 500000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(state))
      )
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Некоректний стан узагальнення.",
        );
      const data = await repository.editSummary(
        noteId,
        summaryId,
        req.authUser!.uid,
        state as string | undefined,
      );
      res.json({ ok: true, data });
    },
  );

  app.post(
    "/api/summarize",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const user = req.authUser!;
      const parsed = SummarizeRequestSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Перевірте параметри узагальнення.",
        );
      const input = parsed.data;
      const modelId = input.modelId ?? modelCatalog.defaultModelId;
      if (!modelCatalog.models.some((model) => model.id === modelId)) {
        throw new AppError(
          400,
          "INVALID_MODEL",
          "Оберіть доступну модель узагальнення.",
        );
      }
      const operationKey = `${user.uid}:${input.requestId}`;
      const fingerprint = JSON.stringify([
        input.noteId,
        input.revision,
        modelId,
        input.options.language,
        input.options.length,
        input.options.generateTags,
        input.options.generateTitle === true,
      ]);
      const assertSameRequest = (pending: PendingGeneration | undefined) => {
        if (pending && pending.fingerprint !== fingerprint) {
          throw new AppError(
            409,
            "DUPLICATE_REQUEST",
            "Ідентифікатор запиту вже використовується з іншими параметрами.",
          );
        }
      };
      assertSameRequest(inFlight.get(operationKey));
      const assertNotCompleted = () => {
        const previous = generations.get(operationKey);
        if (previous && previous.expiresAt > now())
          throw new AppError(
            409,
            "DUPLICATE_REQUEST",
            "Цей запит уже було оброблено.",
          );
      };
      assertNotCompleted();

      const { note, role } = await getRole(input.noteId, user.uid);
      if (role === "viewer")
        throw new AppError(403, "FORBIDDEN", "Недостатньо прав.");
      if (!note.content.trim())
        throw new AppError(
          400,
          "EMPTY_NOTE",
          "Додайте текст до нотатки перед узагальненням.",
        );
      if (note.content.length > config.maxNoteChars)
        throw new AppError(
          413,
          "NOTE_TOO_LARGE",
          "Текст нотатки перевищує дозволений обсяг.",
        );
      if (note.revision !== input.revision)
        throw new AppError(
          409,
          "NOTE_REVISION_CONFLICT",
          "Нотатку змінено в іншому сеансі.",
        );

      const sendCurrentResult = async (
        work: Promise<GenerationResult>,
        status: number,
      ) => {
        const data = await work;
        const { note: latest } = await getRole(input.noteId, user.uid);
        if (data.outdated || latest.revision !== input.revision) {
          throw new AppError(
            409,
            "NOTE_REVISION_CONFLICT",
            "Нотатку змінено під час узагальнення. Повторіть запит для нової версії.",
          );
        }
        return res.status(status).json({ ok: true, data });
      };

      // Recheck after asynchronous access reads, so concurrent requests share work.
      const pending = inFlight.get(operationKey);
      assertSameRequest(pending);
      if (pending) return sendCurrentResult(pending.result, 202);
      assertNotCompleted();

      const startedAt = now();
      const controller = new AbortController();
      const deadline = AbortSignal.timeout(GENERATION_DEADLINE_MS);
      const signal = AbortSignal.any([controller.signal, deadline]);
      let stopWatching: (() => void) | undefined;
      const work = (async () => {
        await repository.beginGeneration(
          input.noteId,
          input.requestId,
          user.uid,
        );
        stopWatching = repository.watchGeneration(
          input.noteId,
          input.requestId,
          () => controller.abort(),
        );
        let summary;
        try {
          if (controller.signal.aborted) throw new Error("AI_CANCELLED");
          summary = await summarizer.summarize(note.content, input.options, {
            requestId: input.requestId,
            modelId,
            signal,
            reserveUsage:
              config.provider === "gemini"
                ? async (inputTokens, maxOutputTokens) => {
                    const pricing = getModelPricing(modelId, now());
                    const reservedNanoUsd = costNanoUsd(pricing, {
                      inputTokens,
                      outputTokens: maxOutputTokens,
                      thinkingTokens: 0,
                    });
                    const reservation = await budget.reserve(
                      user.uid,
                      reservedNanoUsd,
                    );
                    return {
                      settle: async (usage) =>
                        reservation.settle({
                          spentNanoUsd: usage
                            ? costNanoUsd(pricing, usage)
                            : reservedNanoUsd,
                          inputTokens: usage?.inputTokens ?? 0,
                          outputTokens: usage?.outputTokens ?? 0,
                          thinkingTokens: usage?.thinkingTokens ?? 0,
                          unreportedCalls: usage ? 0 : 1,
                        }),
                    };
                  }
                : undefined,
          });
        } catch (error) {
          if (error instanceof AppError) {
            if (error.code === "AI_BUDGET_EXCEEDED") {
              const snapshot = await budget.read(user.uid);
              res.set(
                "Retry-After",
                String(
                  Math.max(
                    1,
                    Math.ceil((Date.parse(snapshot.resetsAt) - now()) / 1000),
                  ),
                ),
              );
            }
            throw error;
          }
          if (controller.signal.aborted)
            throw new AppError(409, "AI_CANCELLED", "Генерацію скасовано.");
          if (deadline.aborted)
            throw new AppError(504, "AI_TIMEOUT", "Час очікування вичерпано.");
          const message =
            error instanceof Error ? error.message : "AI_PROVIDER_FAILURE";
          if (message === "NOTE_TOO_LONG")
            throw new AppError(
              413,
              "NOTE_TOO_LARGE",
              "Текст нотатки завеликий для узагальнення.",
            );
          const failure = normalizeProviderError(error);
          console.error(
            JSON.stringify({
              event: "summarization_provider_failed",
              requestId: req.requestId,
              summaryRequestId: input.requestId,
              provider: config.provider,
              modelId,
              code: failure.code,
              upstreamStatus: failure.upstreamStatus,
              providerReason: failure.providerReason,
              durationMs: Math.max(0, now() - startedAt),
            }),
          );
          const failures = {
            AI_AUTH_FAILED: [
              502,
              "Gemini відхилив серверний ключ або його дозволи. Перевірте налаштування API.",
            ],
            AI_MODEL_NOT_FOUND: [
              502,
              "Обрана модель Gemini недоступна. Оберіть іншу модель та повторіть спробу.",
            ],
            AI_RATE_LIMITED: [
              429,
              "Квоту Gemini вичерпано або перевищено ліміт запитів. Спробуйте пізніше.",
            ],
            AI_REQUEST_REJECTED: [
              502,
              "Gemini відхилив параметри запиту. Перевірте серверний адаптер.",
            ],
            AI_TIMEOUT: [
              504,
              "Час очікування узагальнення вичерпано. Повторіть спробу.",
            ],
            AI_INVALID_RESPONSE: [
              502,
              "Сервіс узагальнення повернув некоректний результат.",
            ],
            AI_UNAVAILABLE: [
              503,
              "Сервіс Gemini тимчасово недоступний. Перевірте підключення та повторіть спробу.",
            ],
          } as const;
          const [status, userMessage] = failures[failure.code];
          throw new AppError(status, failure.code, userMessage);
        }
        const { note: latest } = await getRole(input.noteId, user.uid);
        if (controller.signal.aborted)
          throw new AppError(409, "AI_CANCELLED", "Генерацію скасовано.");
        if (deadline.aborted)
          throw new AppError(504, "AI_TIMEOUT", "Час очікування вичерпано.");
        const outdated = latest.revision !== input.revision;
        if (outdated) {
          throw new AppError(
            409,
            "NOTE_REVISION_CONFLICT",
            "Нотатку змінено під час узагальнення. Повторіть запит для нової версії.",
          );
        }
        const durationMs = Math.max(0, now() - startedAt);
        const savedSummary = await repository.saveSummary(
          input.noteId,
          input.revision,
          summary,
          {
            modelId,
            promptVersion: config.promptVersion,
            durationMs,
            isUserEdited: false,
            generationRequestId: input.requestId,
            actorUid: user.uid,
          },
        );
        const result: GenerationResult = {
          noteId: input.noteId,
          sourceRevision: input.revision,
          requestId: input.requestId,
          summary,
          modelId,
          promptVersion: config.promptVersion,
          durationMs,
          outdated,
          saved: true,
          summaryId: savedSummary.id,
        };
        generations.set(operationKey, {
          noteId: input.noteId,
          sourceRevision: input.revision,
          modelId: result.modelId,
          promptVersion: config.promptVersion,
          durationMs,
          expiresAt: now() + 10 * 60_000,
        });
        const uidHash = createHash("sha256")
          .update(user.uid)
          .digest("hex")
          .slice(0, 12);
        console.info(
          JSON.stringify({
            requestId: input.requestId,
            uidHash,
            modelId: result.modelId,
            promptVersion: config.promptVersion,
            durationMs,
            status: outdated ? "outdated" : "success",
          }),
        );
        return result;
      })();
      inFlight.set(operationKey, {
        fingerprint,
        result: work,
        noteId: input.noteId,
        requestId: input.requestId,
        controller,
      });
      try {
        return await sendCurrentResult(work, 200);
      } finally {
        stopWatching?.();
        try {
          await repository.finishGeneration(
            input.noteId,
            input.requestId,
            controller.signal.aborted ? "cancelled" : "failed",
          );
        } finally {
          if (inFlight.get(operationKey)?.result === work)
            inFlight.delete(operationKey);
        }
      }
    },
  );

  app.post(
    "/api/notes/:noteId/summaries",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const parsed = SaveSummaryRequestSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Перевірте поля узагальнення.",
        );
      const { note, role } = await getRole(noteId, req.authUser!.uid);
      if (role === "viewer")
        throw new AppError(
          403,
          "FORBIDDEN",
          "У вас немає дозволу зберігати зміни.",
        );
      let metadata: Omit<SummarySaveMetadata, "actorUid">;
      if (parsed.data.baseSummaryId) {
        const base = await repository.getSummary(
          noteId,
          parsed.data.baseSummaryId,
        );
        if (!base || base.noteId !== noteId)
          throw new AppError(
            404,
            "SUMMARY_NOT_FOUND",
            "Результат не знайдено.",
          );
        if (base.sourceRevision !== parsed.data.sourceRevision)
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "Версія джерела має відповідати збереженому результату.",
          );
        metadata = {
          modelId: base.modelId,
          promptVersion: base.promptVersion,
          durationMs: base.durationMs,
          baseSummaryId: base.id,
        };
      } else {
        if (note.revision !== parsed.data.sourceRevision)
          throw new AppError(
            409,
            "NOTE_REVISION_CONFLICT",
            "Нотатку змінено в іншому сеансі.",
          );
        const record = generations.get(
          `${req.authUser!.uid}:${parsed.data.requestId}`,
        );
        metadata =
          record &&
          record.noteId === noteId &&
          record.sourceRevision === parsed.data.sourceRevision &&
          record.expiresAt > now()
            ? {
                modelId: record.modelId,
                promptVersion: record.promptVersion,
                durationMs: record.durationMs,
              }
            : {
                modelId: "user-authored",
                promptVersion: config.promptVersion,
                durationMs: 0,
              };
      }
      let saved;
      try {
        saved = await repository.saveSummary(
          noteId,
          parsed.data.sourceRevision,
          parsed.data.summary,
          { ...metadata, actorUid: req.authUser!.uid },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "NOTE_REVISION_CONFLICT"
        )
          throw new AppError(
            409,
            "NOTE_REVISION_CONFLICT",
            "Нотатку змінено в іншому сеансі.",
          );
        if (error instanceof Error && error.message === "SUMMARY_NOT_FOUND")
          throw new AppError(
            404,
            "SUMMARY_NOT_FOUND",
            "Результат не знайдено.",
          );
        if (
          error instanceof Error &&
          error.message === "SUMMARY_SOURCE_MISMATCH"
        )
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "Версія джерела має відповідати збереженому результату.",
          );
        throw error;
      }
      res.status(201).json({ ok: true, data: saved });
    },
  );

  app.get(
    "/api/notes/:noteId/summaries",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      await getRole(noteId, req.authUser!.uid);
      const rawLimit = Number(req.query.limit ?? 20);
      const limit = Number.isInteger(rawLimit)
        ? Math.min(50, Math.max(1, rawLimit))
        : 20;
      const summaries = await repository.listSummaries(noteId, limit);
      res.json({ ok: true, data: { summaries } });
    },
  );

  app.post(
    "/api/notes/:noteId/summaries/:summaryId/feedback",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const summaryId = routeParam(req, "summaryId");
      const parsed = FeedbackRequestSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Оцінка має бути від 1 до 5.",
        );
      await getRole(noteId, req.authUser!.uid);
      await repository.saveFeedback(
        noteId,
        summaryId,
        req.authUser!.uid,
        parsed.data,
      );
      res.json({ ok: true, data: { saved: true } });
    },
  );

  app.get(
    "/api/notes/:noteId/shares",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const { role } = await getRole(noteId, req.authUser!.uid);
      if (role !== "owner")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Перегляд списку доступів дозволено лише власнику.",
        );
      res.json({
        ok: true,
        data: { shares: await repository.listShares(noteId) },
      });
    },
  );

  app.post(
    "/api/notes/:noteId/shares",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const parsed = ShareRequestSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Вкажіть коректну пошту й роль.",
        );
      const { role } = await getRole(noteId, req.authUser!.uid);
      if (role !== "owner")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Надавати доступ може лише власник нотатки.",
        );
      const participant = await repository.findUserByEmail(
        parsed.data.email.toLowerCase(),
      );
      if (!participant)
        throw new AppError(
          404,
          "USER_NOT_FOUND",
          "Обліковий запис із такою поштою не знайдено.",
        );
      if (participant.uid === req.authUser!.uid)
        throw new AppError(
          400,
          "INVALID_SHARE",
          "Власник уже має доступ до цієї нотатки.",
        );
      await repository.upsertShare(noteId, participant.uid, {
        noteId,
        participantUid: participant.uid,
        email: participant.email,
        role: parsed.data.role,
        status: "accepted",
        createdBy: req.authUser!.uid,
      });
      res.status(201).json({
        ok: true,
        data: {
          participantUid: participant.uid,
          role: parsed.data.role,
          status: "accepted",
        },
      });
    },
  );

  app.delete(
    "/api/notes/:noteId/shares/:participantUid",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const participantUid = routeParam(req, "participantUid");
      const { role } = await getRole(noteId, req.authUser!.uid);
      if (role !== "owner")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Керувати доступом може лише власник нотатки.",
        );
      if (participantUid === req.authUser!.uid)
        throw new AppError(
          400,
          "INVALID_SHARE",
          "Не можна відкликати доступ власника.",
        );
      await repository.deleteShare(noteId, participantUid);
      res.json({ ok: true, data: { revoked: true } });
    },
  );

  app.delete(
    "/api/notes/:noteId",
    authenticate,
    async (req: AuthenticatedRequest, res) => {
      const noteId = routeParam(req, "noteId");
      const { role } = await getRole(noteId, req.authUser!.uid);
      if (role !== "owner")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Видалити нотатку може лише власник.",
        );
      await repository.deleteNoteCascade(noteId);
      res.json({ ok: true, data: { deleted: true } });
    },
  );

  app.use((_req, res) =>
    res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Маршрут не знайдено." },
    }),
  );

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    req: AuthenticatedRequest,
    res,
    next,
  ) => {
    void next;
    if (res.headersSent) return;
    const parseError = error as { status?: number; type?: string };
    const appError =
      error instanceof AppError
        ? error
        : parseError.status === 400 && parseError.type === "entity.parse.failed"
          ? new AppError(
              400,
              "INVALID_JSON",
              "Запит має містити коректний JSON.",
            )
          : new AppError(
              500,
              "INTERNAL_ERROR",
              "Сталася помилка. Спробуйте ще раз.",
            );
    const requestId = req.requestId ?? randomUUID();
    if (appError.status >= 500)
      console.error(
        JSON.stringify({
          requestId,
          code: appError.code,
          status: appError.status,
        }),
      );
    res.status(appError.status).json({
      ok: false,
      error: { code: appError.code, message: appError.message, requestId },
    });
  };
  app.use(errorHandler);
  return app;
}
