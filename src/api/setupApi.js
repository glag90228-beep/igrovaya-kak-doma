'use strict';

const express = require('express');
const {
  errorHandler,
  responseFormatterMiddleware,
  responseLoggingMiddleware,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  ApiError,
} = require('./middleware');

/**
 * Инициализирует Express приложение с необходимым middleware и обработчиками ошибок
 * @param {Express.Application} app - Express приложение
 * @param {Object} options - опции конфигурации
 * @returns {Express.Application} - настроенное приложение
 */
function setupApi(app, options = {}) {
  const {
    trustProxy = false,
    enableLogging = true,
    enableCompression = true,
  } = options;

  // Базовые настройки
  if (trustProxy) {
    app.set('trust proxy', 1);
  }

  // Парсинг JSON
  app.use(express.json({ limit: options.jsonLimit || '10mb' }));
  app.use(express.urlencoded({ limit: options.urlLimit || '10mb', extended: true }));

  // Сжатие ответов (опционально)
  if (enableCompression) {
    const compression = require('compression');
    app.use(compression());
  }

  // CORS (если требуется)
  if (options.enableCors) {
    const cors = require('cors');
    app.use(cors(options.corsOptions || {}));
  }

  // Форматирование ответов
  app.use(responseFormatterMiddleware);

  // Логирование (опционально)
  if (enableLogging) {
    app.use(responseLoggingMiddleware);
  }

  // Обработка 404
  app.use((req, res, next) => {
    throw new NotFoundError(`Endpoint ${req.method} ${req.path} not found`);
  });

  // Обработка ошибок (ДОЛЖЕН быть последним)
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return errorHandler(new ValidationError('Invalid JSON in request body'), req, res, next);
    }

    errorHandler(err, req, res, next);
  });

  return app;
}

/**
 * Оборачивает async обработчик маршрута для автоматической обработки ошибок
 * @param {Function} handler - async обработчик маршрута
 * @returns {Function} - обработчик для Express
 */
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Требует аутентификацию
 * @param {Function} authCheck - функция проверки аутентификации
 * @returns {Function} - middleware
 */
function requireAuth(authCheck) {
  return asyncHandler(async (req, res, next) => {
    const user = await authCheck(req);
    if (!user) {
      throw new UnauthorizedError('Authentication required');
    }

    req.user = user;
    next();
  });
}

/**
 * Требует определённые права доступа
 * @param {Array<string>} permissions - требуемые права
 * @returns {Function} - middleware
 */
function requirePermissions(permissions = []) {
  return (req, res, next) => {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const userPerms = req.user.permissions || [];
    const hasPermission = permissions.some(p => userPerms.includes(p));

    if (!hasPermission) {
      throw new ForbiddenError('Insufficient permissions');
    }

    next();
  };
}

/**
 * Ограничение частоты запросов (простое)
 * @param {Object} options - опции (maxRequests, windowMs)
 * @returns {Function} - middleware
 */
function rateLimit(options = {}) {
  const {
    maxRequests = 100,
    windowMs = 60000, // 1 минута
    keyGenerator = (req) => req.ip,
  } = options;

  const requests = new Map();

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!requests.has(key)) {
      requests.set(key, []);
    }

    const timestamps = requests.get(key).filter(t => t > windowStart);

    if (timestamps.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: {
          message: 'Too many requests',
          code: 429,
        },
      });
    }

    timestamps.push(now);
    requests.set(key, timestamps);

    // Очистка старых ключей
    if (requests.size > 10000) {
      for (const [k, v] of requests.entries()) {
        if (v.length === 0) {
          requests.delete(k);
        }
      }
    }

    next();
  };
}

module.exports = {
  setupApi,
  asyncHandler,
  requireAuth,
  requirePermissions,
  rateLimit,

  // Экспортируем ошибки для использования в маршрутах
  ApiError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
};
