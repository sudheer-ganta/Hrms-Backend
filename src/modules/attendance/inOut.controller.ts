import { Request, Response } from 'express';
import { inOutService } from './inOut.service.js';
import { getTodayDateString } from '../../utils/dateUtils.js';

export class InOutController {
  /**
   * GET /api/attendance/in-out
   * Returns Check-in, Check-out, Working hours, Overtime and stats
   */
  public static async getInOutAttendance(req: Request, res: Response): Promise<void> {
    try {
      const {
        sourceId,
        fromDate,
        toDate,
        employeeCode,
        search,
        status,
        page,
        limit,
        sortBy,
        sortOrder,
      } = req.query;

      const result = await inOutService.getInOutRecords({
        sourceId: sourceId ? String(sourceId) : undefined,
        fromDate: fromDate ? String(fromDate) : undefined,
        toDate: toDate ? String(toDate) : undefined,
        employeeCode: employeeCode ? String(employeeCode) : undefined,
        search: search ? String(search) : undefined,
        status: status ? String(status) : undefined,
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 50,
        sortBy: sortBy ? String(sortBy) : 'date',
        sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
      });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
        summary: result.summary,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to retrieve IN/OUT attendance records',
      });
    }
  }

  /**
   * GET /api/attendance/timesheet
   * Returns employee timesheet matrix across date range
   */
  public static async getTimesheet(req: Request, res: Response): Promise<void> {
    try {
      const { sourceId, fromDate, toDate, search } = req.query;
      const today = getTodayDateString();

      const from = fromDate ? String(fromDate) : today;
      const to = toDate ? String(toDate) : today;

      const result = await inOutService.getTimesheetMatrix({
        sourceId: sourceId ? String(sourceId) : undefined,
        fromDate: from,
        toDate: to,
        search: search ? String(search) : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to generate timesheet matrix',
      });
    }
  }

  /**
   * POST /api/sync/in-out/:sourceId
   */
  public static async syncSingleSourceInOut(req: Request, res: Response): Promise<void> {
    try {
      const sourceIdParam = req.params.sourceId;
      const sourceId = Array.isArray(sourceIdParam) ? sourceIdParam[0] : String(sourceIdParam);
      const { fromDate, toDate, empCode } = req.body || {};

      if (!sourceId) {
        res.status(400).json({ success: false, error: 'Source ID is required' });
        return;
      }

      const today = getTodayDateString();
      const result = await inOutService.syncInOutData({
        sourceId,
        fromDate: fromDate || today,
        toDate: toDate || today,
        empCode: empCode || 'ALL',
      });

      res.json(result);
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to sync IN/OUT attendance',
      });
    }
  }

  /**
   * POST /api/sync/in-out/all
   */
  public static async syncAllSourcesInOut(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate, empCode } = req.body || {};
      const today = getTodayDateString();

      const result = await inOutService.syncAllLocationsInOut({
        fromDate: fromDate || today,
        toDate: toDate || today,
        empCode: empCode || 'ALL',
      });

      res.json(result);
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to sync all IN/OUT records',
      });
    }
  }
}
