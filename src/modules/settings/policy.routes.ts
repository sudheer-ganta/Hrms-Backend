import { Router } from 'express';
import { PolicyController } from './policy.controller.js';

const router = Router();

router.get('/', PolicyController.getSettings);
router.put('/', PolicyController.updateSettings);
router.post('/holidays', PolicyController.addHoliday);
router.delete('/holidays/:id', PolicyController.removeHoliday);

export default router;
