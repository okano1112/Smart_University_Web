'use strict';

const express = require('express');
const { calculateCoolingForecast, ForecastInputError } = require('./cooling-forecast');

function createCoolingForecastRouter({ now = Date.now } = {}) {
  const router = express.Router();
  router.post('/', (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(calculateCoolingForecast(req.body, { now: now() }));
    } catch (error) {
      if (error instanceof ForecastInputError) return res.status(400).json({ kind: 'invalid', message: error.message, method: 'local_trend' });
      next(error);
    }
  });
  return router;
}

module.exports = { createCoolingForecastRouter };
