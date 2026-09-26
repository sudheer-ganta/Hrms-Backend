import { Router } from 'express';
import { SourcesController } from './sources.controller.js';

const router = Router();

router.get('/', SourcesController.getSources);

export default router;
