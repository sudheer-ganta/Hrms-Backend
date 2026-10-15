import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware.js';
import { employeeMasterService, maskProfile } from './employeeMaster.service.js';
import { identityService } from './identity.service.js';
import { handle, ApiError } from '../../utils/apiError.js';
import { isValidEmpCode, normalizeEmpCode } from '../../utils/empCode.js';
import { requireObject } from '../../utils/validate.js';
import { getSourceById } from '../../config/env.js';

const isAdmin = (req: AuthRequest) => req.user?.role !== 'EMPLOYEE';

export class EmployeeMasterController {
  public getAllProfiles = handle(async (req: AuthRequest, res: Response) => {
    let profiles = await employeeMasterService.getAllProfiles();
    if (!isAdmin(req)) {
      // An employee login never sees colleagues' data.
      const own = normalizeEmpCode(req.user!.empCode);
      profiles = profiles.filter((p) => p.empCode === own);
    }
    // Roster lists carry masked identity numbers; the detail endpoint returns the full record.
    res.json({ success: true, count: profiles.length, data: profiles.map(maskProfile) });
  });

  public getProfile = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await employeeMasterService.requireProfile(String(req.params.empCode)) });
  });

  public createProfile = handle(async (req: AuthRequest, res: Response) => {
    res.status(201).json({ success: true, data: await employeeMasterService.createProfile(req.body) });
  });

  public updateProfile = handle(async (req: AuthRequest, res: Response) => {
    const code = normalizeEmpCode(req.params.empCode);
    if (!isValidEmpCode(code)) throw ApiError.validation('Invalid employee code.', [{ field: 'empCode', issue: 'Invalid' }]);
    res.json({ success: true, data: await employeeMasterService.updateProfile(code, req.body) });
  });

  /** POST /employees/salary-preview: the single backend salary formula, nothing persisted. */
  public previewSalary = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await employeeMasterService.previewSalary(req.body) });
  });

  public listMappings = handle(async (req: AuthRequest, res: Response) => {
    res.json({ success: true, data: await identityService.listMappings(normalizeEmpCode(req.params.empCode)) });
  });

  public setMapping = handle(async (req: AuthRequest, res: Response) => {
    const body = requireObject(req.body);
    const empCode = normalizeEmpCode(req.params.empCode);
    const source = getSourceById(String(body.sourceId ?? ''));
    if (!source) throw ApiError.validation('Unknown sourceId.', [{ field: 'sourceId', issue: 'Unknown source' }]);
    if (!isValidEmpCode(body.vendorEmployeeCode)) throw ApiError.validation('Invalid vendorEmployeeCode.', [{ field: 'vendorEmployeeCode', issue: 'Invalid' }]);
    await employeeMasterService.requireProfile(empCode);
    await identityService.setMapping(source.id, body.vendorEmployeeCode, empCode);
    res.json({ success: true, data: await identityService.listMappings(empCode) });
  });
}

export const employeeMasterController = new EmployeeMasterController();
