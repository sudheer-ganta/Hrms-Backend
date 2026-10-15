import { Router } from 'express';
import { requestsController } from './requests.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();

// EMPLOYEE_SELF
router.get('/', ...access.EMPLOYEE_SELF, requestsController.getRequests);
router.post('/', ...access.EMPLOYEE_SELF, requestsController.createRequest);
router.post('/:id/cancel', ...access.EMPLOYEE_SELF, requestsController.cancel);
router.get('/balance/:empCode', ...access.EMPLOYEE_SELF, requestsController.getLeaveBalance);

// HR_OR_ABOVE
router.patch('/:id/status', ...access.HR_OR_ABOVE, requestsController.updateStatus);
router.post('/:id/apply', ...access.HR_OR_ABOVE, requestsController.retryApply);
router.post('/:id/revoke', ...access.HR_OR_ABOVE, requestsController.revoke);

export default router;
