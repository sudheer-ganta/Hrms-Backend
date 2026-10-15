import { Router } from 'express';
import { syncController } from './sync.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();
// FOUNDER_OR_SUPER_ADMIN for everything under /sync
router.use(...access.FOUNDER_OR_SUPER_ADMIN);

// Raw punches (vendor API 2)
router.post('/all', syncController.syncRawAll);
// Daily IN/OUT (vendor API 3); declared before '/:sourceId' so "in-out" is never read as a source id
router.post('/in-out/all', syncController.syncInOutAll);
router.post('/in-out/:sourceId', syncController.syncInOutOne);
router.post('/:sourceId', syncController.syncRawOne);

router.get('/logs', syncController.getSyncLogs);

router.get('/scheduler/status', syncController.getSchedulerStatus);
router.post('/scheduler/toggle', syncController.toggleScheduler);
router.post('/scheduler/trigger-now', syncController.triggerSchedulerNow);

export default router;
