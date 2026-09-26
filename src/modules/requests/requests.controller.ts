import { Request, Response } from 'express';
import { requestsService } from './requests.service.js';

export class RequestsController {
  public static getRequests(req: Request, res: Response): void {
    try {
      const { empCode, status } = req.query;
      const list = requestsService.getRequests({
        empCode: empCode ? String(empCode) : undefined,
        status: status ? String(status) : undefined,
      });
      res.json({ success: true, data: list });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to get requests' });
    }
  }

  public static createRequest(req: Request, res: Response): void {
    try {
      const { empCode, empName, requestType, date, inTime, outTime, leaveType, reason } = req.body;
      if (!empCode || !requestType || !date || !reason) {
        res.status(400).json({ success: false, error: 'empCode, requestType, date, and reason are required' });
        return;
      }
      const created = requestsService.createRequest({
        empCode,
        empName: empName || 'Employee',
        requestType,
        date,
        inTime,
        outTime,
        leaveType,
        reason,
      });
      res.json({ success: true, data: created, message: 'Request submitted successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to submit request' });
    }
  }

  public static updateStatus(req: Request, res: Response): void {
    try {
      const id = req.params.id as string;
      const { status, reviewComment } = req.body;
      if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
        res.status(400).json({ success: false, error: 'Valid status (APPROVED | REJECTED) required' });
        return;
      }
      const updated = requestsService.updateStatus(id, status, reviewComment);
      if (!updated) {
        res.status(404).json({ success: false, error: 'Request not found' });
        return;
      }
      res.json({ success: true, data: updated, message: `Request ${status.toLowerCase()} successfully` });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to update request' });
    }
  }

  public static getLeaveBalance(req: Request, res: Response): void {
    try {
      const empCode = req.params.empCode as string;
      const balance = requestsService.getLeaveBalance(empCode);
      res.json({ success: true, data: balance });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to get leave balance' });
    }
  }
}
