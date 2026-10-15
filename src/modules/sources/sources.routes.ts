import { Router } from 'express';
import { SourcesController } from './sources.controller.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();

// AUTHENTICATED
router.get('/', ...access.AUTHENTICATED, SourcesController.getSources);
router.get('/sites', ...access.AUTHENTICATED, SourcesController.getSites);

// FOUNDER_OR_SUPER_ADMIN: site geofence and display configuration
router.put('/sites/:siteId', ...access.FOUNDER_OR_SUPER_ADMIN, SourcesController.updateSite);

export default router;
