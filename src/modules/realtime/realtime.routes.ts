import { Router, Request, Response } from 'express';
import { revisionService, DataRevision } from './revision.service.js';
import { access } from '../../middleware/auth.middleware.js';

const router = Router();

// Version check endpoint: public or authenticated, lightweight in-memory read
router.get('/version', (_req: Request, res: Response) => {
  res.json({ success: true, data: revisionService.getRevision() });
});

// Server-Sent Events stream for real-time invalidation across users & devices
router.get('/stream', ...access.AUTHENTICATED, (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Immediately send initial version
  const initial = revisionService.getRevision();
  res.write(`event: init\ndata: ${JSON.stringify(initial)}\n\n`);

  const onChange = (rev: DataRevision) => {
    try {
      res.write(`event: change\ndata: ${JSON.stringify(rev)}\n\n`);
    } catch {
      // client connection likely terminated
    }
  };

  revisionService.on('change', onChange);

  // Keep-alive heartbeat every 20 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    revisionService.off('change', onChange);
    res.end();
  });
});

export default router;
