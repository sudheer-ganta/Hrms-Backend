import { Request, Response } from 'express';
import { attendanceService } from './attendance.service.js';

export class AttendanceController {
  /**
   * GET /api/attendance
   * Fetch paginated attendance records with location and date filtering
   */
  public static async getAttendance(req: Request, res: Response): Promise<void> {
    try {
      const {
        sourceId,
        fromDate,
        toDate,
        employeeCode,
        search,
        machineId,
        page,
        limit,
        sortBy,
        sortOrder,
      } = req.query;

      const result = await attendanceService.getAttendanceRecords({
        sourceId: sourceId ? String(sourceId) : undefined,
        fromDate: fromDate ? String(fromDate) : undefined,
        toDate: toDate ? String(toDate) : undefined,
        employeeCode: employeeCode ? String(employeeCode) : undefined,
        search: search ? String(search) : undefined,
        machineId: machineId ? String(machineId) : undefined,
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 50,
        sortBy: sortBy ? String(sortBy) : 'punchDateTime',
        sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
      });

      res.json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to retrieve attendance records',
      });
    }
  }

  /**
   * GET /api/attendance/raw-swipes
   * Equivalent or detailed endpoint for raw swipe inspection
   */
  public static async getRawSwipes(req: Request, res: Response): Promise<void> {
    return AttendanceController.getAttendance(req, res);
  }

  /**
   * GET /api/attendance/stats
   */
  public static async getDashboardStats(req: Request, res: Response): Promise<void> {
    try {
      const { date, sourceId } = req.query;
      const stats = await attendanceService.getDashboardStats(
        date ? String(date) : undefined,
        sourceId ? String(sourceId) : undefined
      );
      res.json({
        success: true,
        data: stats,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to retrieve dashboard statistics',
      });
    }
  }
}
