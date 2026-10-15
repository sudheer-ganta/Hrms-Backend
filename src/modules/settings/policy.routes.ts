import { Router } from 'express';
import { PolicyController } from './policy.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();
const controller = new PolicyController();

// AUTHENTICATED: everyone needs the policy to render calendars and thresholds
router.get('/', ...access.AUTHENTICATED, controller.getSettings);

// FOUNDER_OR_SUPER_ADMIN: policy settings, shifts, grace periods, holidays (excludes HR)
router.put('/', ...access.FOUNDER_OR_SUPER_ADMIN, controller.updateSettings);
router.post('/holidays', ...access.FOUNDER_OR_SUPER_ADMIN, controller.addHoliday);
router.delete('/holidays/:id', ...access.FOUNDER_OR_SUPER_ADMIN, controller.removeHoliday);

export default router;
