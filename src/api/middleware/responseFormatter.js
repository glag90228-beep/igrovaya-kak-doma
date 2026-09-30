'use strict';

// Стандартный формат ответа
function sendSuccess(res, data, message = null, statusCode = 200) {
  const response = {
    success: true,
    data,
  };

  if (message) {
    response.message = message;
  }

  res.status(statusCode).json(response);
}

function sendPaginated(res, data, total, limit, offset, statusCode = 200) {
  const response = {
    success: true,
    data,
    pagination: {
      total,
      limit,
      offset,
      pages: Math.ceil(total / limit),
    },
  };

  res.status(statusCode).json(response);
}

function sendCreated(res, data, message = 'Created successfully') {
  sendSuccess(res, data, message, 201);
}

function sendAccepted(res, data, message = 'Request accepted') {
  sendSuccess(res, data, message, 202);
}

function sendNoContent(res) {
  res.status(204).end();
}

// Middleware для добавления методов в объект res
function responseFormatterMiddleware(req, res, next) {
  res.sendSuccess = (data, message, statusCode) => sendSuccess(res, data, message, statusCode);
  res.sendPaginated = (data, total, limit, offset, statusCode) => sendPaginated(res, data, total, limit, offset, statusCode);
  res.sendCreated = (data, message) => sendCreated(res, data, message);
  res.sendAccepted = (data, message) => sendAccepted(res, data, message);
  res.sendNoContent = () => sendNoContent(res);

  next();
}

// Middleware для логирования ответов
function responseLoggingMiddleware(req, res, next) {
  const originalJson = res.json;

  res.json = function(body) {
    const statusCode = res.statusCode;
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        method: req.method,
        path: req.path,
        statusCode,
        success: body.success,
        duration: Date.now() - req.startTime || 0,
      };

      if (body.error) {
        logEntry.error = body.error.message;
      }

      console.log(JSON.stringify(logEntry));
    }

    return originalJson.call(this, body);
  };

  req.startTime = Date.now();
  next();
}

module.exports = {
  sendSuccess,
  sendPaginated,
  sendCreated,
  sendAccepted,
  sendNoContent,
  responseFormatterMiddleware,
  responseLoggingMiddleware,
};
