'use strict';

const express = require('express');
const { ScheduleError } = require('./ac-scheduler');

function createScheduleRouter({ scheduler }) {
  const router = express.Router();
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      res.status(error instanceof ScheduleError ? error.status : 503).json({ success: false, message: error instanceof ScheduleError ? error.message : 'บันทึกตารางเวลาไม่สำเร็จ กรุณาตรวจสอบเซิร์ฟเวอร์' });
    }
  };
  router.get('/', route(async (req, res) => res.json(await scheduler.list())));
  router.post('/', route(async (req, res) => res.status(201).json({ schedule: await scheduler.create(req.body) })));
  router.patch('/:id', route(async (req, res) => res.json({ schedule: await scheduler.update(req.params.id, req.body) })));
  router.delete('/:id', route(async (req, res) => res.json(await scheduler.remove(req.params.id))));
  return router;
}

module.exports = { createScheduleRouter };
