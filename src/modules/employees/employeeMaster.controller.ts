import { Request, Response } from 'express';
import { employeeMasterService } from './employeeMaster.service.js';
import { payrollService } from '../payroll/payroll.service.js';

export class EmployeeMasterController {
  public getAllProfiles = async (req: Request, res: Response) => {
    try {
      const profiles = await employeeMasterService.getAllProfiles();
      res.json({
        success: true,
        count: profiles.length,
        data: profiles
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public getProfile = async (req: Request, res: Response) => {
    try {
      const empCode = req.params.empCode as string;
      const profile = await employeeMasterService.getProfile(empCode);
      if (!profile) {
        return res.status(404).json({ success: false, error: `Employee ${empCode} not found` });
      }
      res.json({ success: true, data: profile });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };

  public updateProfile = async (req: Request, res: Response) => {
    try {
      const empCode = req.params.empCode as string;
      const updated = await employeeMasterService.updateProfile(empCode, req.body);
      // A salary/CTC/OT-rate change should be reflected immediately, not after
      // the cache's safety-net TTL expires.
      payrollService.invalidateAllPayrollCache();
      res.json({
        success: true,
        message: `Employee ${empCode} profile updated successfully`,
        data: updated
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

export const employeeMasterController = new EmployeeMasterController();
