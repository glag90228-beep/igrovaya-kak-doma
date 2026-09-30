'use strict';

module.exports = {
  // API setup
  ...require('./setupApi'),

  // Middleware
  middleware: require('./middleware'),

  // Utils
  utils: require('./utils'),
};
