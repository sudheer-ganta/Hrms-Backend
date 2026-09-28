import { Request, Response } from 'express';
import { attendanceService } from './attendance.service.js';
import { punchService } from './punch.service.js';
import { AuthRequest } from '../../middleware/auth.middleware.js';

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

  /**
   * GET /api/attendance/punch/today
   * Get current employee's punch status for today (IST)
   */
  public static async getTodayPunchStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const empCode = (req.query.empCode as string) || req.user?.empCode || '0132';
      const status = await punchService.getTodayStatus(empCode);
      res.json({
        success: true,
        data: status,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to retrieve today punch status',
      });
    }
  }

  /**
   * POST /api/attendance/punch
   * Record Check-In / Check-Out with server-enforced IST time and GPS location
   */
  public static async recordPunch(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { punchType, latitude, longitude, accuracy, address, notes, empCode } = req.body;
      const finalEmpCode = empCode || req.user?.empCode;

      if (!finalEmpCode) {
        res.status(400).json({
          success: false,
          error: 'Employee code is required to record attendance punch.',
        });
        return;
      }

      const result = await punchService.recordPunch({
        empCode: finalEmpCode,
        empName: req.user?.name,
        punchType: punchType || 'AUTO',
        latitude: latitude !== undefined ? Number(latitude) : undefined,
        longitude: longitude !== undefined ? Number(longitude) : undefined,
        accuracy: accuracy !== undefined ? Number(accuracy) : undefined,
        address: address || notes,
        deviceInfo: req.headers['user-agent'],
      });

      res.status(200).json({
        success: true,
        data: result,
        message: result.message,
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to record punch',
      });
    }
  }
}
