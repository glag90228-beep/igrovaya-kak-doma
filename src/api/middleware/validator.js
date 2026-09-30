'use strict';

const { ValidationError } = require('./errorHandler');

// Простая схема валидации
class Schema {
  constructor(rules = {}) {
    this.rules = rules;
  }

  validate(data) {
    const errors = {};

    for (const [field, rule] of Object.entries(this.rules)) {
      const value = data[field];
      const fieldErrors = this.validateField(value, rule);

      if (fieldErrors.length > 0) {
        errors[field] = fieldErrors;
      }
    }

    return Object.keys(errors).length > 0 ? errors : null;
  }

  validateField(value, rule) {
    const errors = [];

    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`${rule.type || 'Field'} is required`);
      return errors;
    }

    if (value === undefined || value === null || value === '') {
      return errors;
    }

    if (rule.type === 'string') {
      if (typeof value !== 'string') {
        errors.push('Must be a string');
      }
      if (rule.minLength && value.length < rule.minLength) {
        errors.push(`Minimum length is ${rule.minLength}`);
      }
      if (rule.maxLength && value.length > rule.maxLength) {
        errors.push(`Maximum length is ${rule.maxLength}`);
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push(rule.patternMessage || 'Invalid format');
      }
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`Must be one of: ${rule.enum.join(', ')}`);
      }
    }

    if (rule.type === 'number') {
      if (typeof value !== 'number' || isNaN(value)) {
        errors.push('Must be a number');
      } else {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`Minimum value is ${rule.min}`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`Maximum value is ${rule.max}`);
        }
      }
    }

    if (rule.type === 'integer') {
      if (!Number.isInteger(value)) {
        errors.push('Must be an integer');
      } else {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`Minimum value is ${rule.min}`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`Maximum value is ${rule.max}`);
        }
      }
    }

    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push('Must be a boolean');
      }
    }

    if (rule.type === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push('Must be an object');
      }
    }

    if (rule.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push('Must be an array');
      } else if (rule.items) {
        for (let i = 0; i < value.length; i++) {
          const itemErrors = this.validateField(value[i], rule.items);
          if (itemErrors.length > 0) {
            errors.push(`Item ${i}: ${itemErrors[0]}`);
          }
        }
      }
    }

    if (rule.custom) {
      const customError = rule.custom(value);
      if (customError) {
        errors.push(customError);
      }
    }

    return errors;
  }
}

// Middleware для валидации тела запроса
function validateBody(schema) {
  return (req, res, next) => {
    const errors = schema.validate(req.body || {});

    if (errors) {
      throw new ValidationError('Validation failed', errors);
    }

    next();
  };
}

// Middleware для валидации query параметров
function validateQuery(schema) {
  return (req, res, next) => {
    const errors = schema.validate(req.query || {});

    if (errors) {
      throw new ValidationError('Invalid query parameters', errors);
    }

    next();
  };
}

// Middleware для валидации path параметров
function validateParams(schema) {
  return (req, res, next) => {
    const errors = schema.validate(req.params || {});

    if (errors) {
      throw new ValidationError('Invalid path parameters', errors);
    }

    next();
  };
}

module.exports = {
  Schema,
  validateBody,
  validateQuery,
  validateParams,
};
