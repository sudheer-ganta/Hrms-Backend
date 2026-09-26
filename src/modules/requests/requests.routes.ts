import { Router } from 'express';
import { RequestsController } from './requests.controller.js';

const router = Router();

router.get('/', RequestsController.getRequests);
router.post('/', RequestsController.createRequest);
router.patch('/:id/status', RequestsController.updateStatus);
router.get('/balance/:empCode', RequestsController.getLeaveBalance);

export default router;
