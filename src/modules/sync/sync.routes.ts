import { Router } from 'express';
import { SyncController } from './sync.controller.js';
import { InOutController } from '../attendance/inOut.controller.js';

const router = Router();

// API 2: Punch Data MCID
router.post('/all', SyncController.syncAllSources);
router.post('/:sourceId', SyncController.syncSingleSource);

// API 3: IN/OUT Attendance Data
router.post('/in-out/all', InOutController.syncAllSourcesInOut);
router.post('/in-out/:sourceId', InOutController.syncSingleSourceInOut);

// Logs
router.get('/logs', SyncController.getSyncLogs);

// Background Auto-Sync Scheduler
router.get('/scheduler/status', SyncController.getSchedulerStatus);
router.post('/scheduler/toggle', SyncController.toggleScheduler);
router.post('/scheduler/trigger-now', SyncController.triggerSchedulerNow);

export default router;
