import { Router } from 'express';
import { employeeMasterController } from './employeeMaster.controller.js';

const router = Router();

router.get('/', employeeMasterController.getAllProfiles);
router.get('/:empCode', employeeMasterController.getProfile);
router.put('/:empCode', employeeMasterController.updateProfile);

export default router;
