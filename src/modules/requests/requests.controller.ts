import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { requestsService } from './requests.service.js';
import { handle, ApiError } from '../../utils/apiError.js';
import { optionalString, requireObject, optionalEnum } from '../../utils/validate.js';
import { REQUEST_STATUSES, RequestStatus } from './requests.types.js';
import { normalizeEmpCode } from '../../utils/empCode.js';

const reviewer = (req: AuthRequest) => req.user?.name || req.user?.email || 'Unknown';

export class RequestsController {
  public getRequests = handle(async (req: AuthRequest, res: Response) => {
    const status = optionalEnum<RequestStatus>(req.query.status, REQUEST_STATUSES, 'status');
    const empCode = req.query.empCode ? normalizeEmpCode(req.query.empCode) : undefined;
    res.json({ success: true, data: await requestsService.getRequests({ empCode, status }) });
  });

  public createRequest = handle(async (req: AuthRequest, res: Response) => {
    // Employees can only ever create requests for themselves (scopeToSelf also pins the code).
    const actingEmpCode = req.user!.role === 'EMPLOYEE' ? req.user!.empCode : undefined;
    const created = await requestsService.createRequest(req.body, actingEmpCode);
    res.status(201).json({ success: true, data: created });
  });

  /** PATCH /requests/:id/status  { status: 'APPROVED' | 'REJECTED', reviewComment? } */
  public updateStatus = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    const id = String(req.params.id);
    const comment = optionalString(body.reviewComment, 'reviewComment', 500);
    if (body.status === 'APPROVED') return res.json({ success: true, data: await requestsService.approve(id, reviewer(req), comment) });
    if (body.status === 'REJECTED') return res.json({ success: true, data: await requestsService.reject(id, reviewer(req), comment) });
    throw ApiError.validation('status must be APPROVED or REJECTED. Use /revoke to undo an approved request.', [{ field: 'status', issue: 'Invalid value' }]);
  });

  public retryApply = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await requestsService.retryApply(String(req.params.id), reviewer(req)) });
  });

  public cancel = handle(async (req: AuthRequest, res: Response) => {
    const own = req.user!.role === 'EMPLOYEE' ? req.user!.empCode : undefined;
    res.json({ success: true, data: await requestsService.cancel(String(req.params.id), reviewer(req), own) });
  });

  public revoke = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body ?? {});
    res.json({ success: true, data: await requestsService.revoke(String(req.params.id), reviewer(req), optionalString(body.reason, 'reason', 500) ?? '') });
  });

  public getLeaveBalance = handle(async (req: AuthRequest, res: Response) => {
    const year = req.query.year ? Number(req.query.year) : undefined;
    if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
      throw ApiError.validation('year must be a 4-digit year.', [{ field: 'year', issue: 'Invalid' }]);
    }
    res.json({ success: true, data: await requestsService.getLeaveBalance(String(req.params.empCode), year) });
  });
}

export const requestsController = new RequestsController();
