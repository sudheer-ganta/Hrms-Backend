import { Router } from 'express';
import { employeeMasterController } from './employeeMaster.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();

// AUTHENTICATED (employees receive only their own record; admins the roster)
router.get('/', ...access.AUTHENTICATED, employeeMasterController.getAllProfiles);

// HR_OR_ABOVE
router.post('/', ...access.HR_OR_ABOVE, employeeMasterController.createProfile);
router.post('/salary-preview', ...access.HR_OR_ABOVE, employeeMasterController.previewSalary);
router.get('/:empCode/source-mappings', ...access.HR_OR_ABOVE, employeeMasterController.listMappings);
router.put('/:empCode/source-mappings', ...access.HR_OR_ABOVE, employeeMasterController.setMapping);
router.put('/:empCode', ...access.HR_OR_ABOVE, employeeMasterController.updateProfile);

// EMPLOYEE_SELF
router.get('/:empCode', ...access.EMPLOYEE_SELF, employeeMasterController.getProfile);

export default router;
