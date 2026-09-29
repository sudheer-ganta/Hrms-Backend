import { Request, Response } from 'express';
import { policyService } from './policy.service.js';

export class PolicyController {
  public static getSettings(req: Request, res: Response): void {
    try {
      const settings = policyService.getSettings();
      res.json({ success: true, data: settings });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to retrieve settings' });
    }
  }

  public static async updateSettings(req: Request, res: Response): Promise<void> {
    try {
      const updated = await policyService.updateSettings(req.body);
      res.json({ success: true, data: updated, message: 'Policy settings updated successfully' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to update settings' });
    }
  }

  public static async addHoliday(req: Request, res: Response): Promise<void> {
    try {
      const { date, name, type } = req.body;
      if (!date || !name) {
        res.status(400).json({ success: false, error: 'Date and holiday name are required' });
        return;
      }
      const holiday = await policyService.addHoliday({ date, name, type: type || 'NATIONAL' });
      res.json({ success: true, data: holiday, message: 'Holiday added successfully' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to add holiday' });
    }
  }

  public static async removeHoliday(req: Request, res: Response): Promise<void> {
    try {
      const id = req.params.id as string;
      await policyService.removeHoliday(id);
      res.json({ success: true, message: 'Holiday removed successfully' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Failed to remove holiday' });
    }
  }
}
