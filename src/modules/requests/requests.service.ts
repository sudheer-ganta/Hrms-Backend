import fs from 'fs';
import path from 'path';
import { AttendanceRegularizationRequest, LeaveBalance } from './requests.types.js';

const REQUESTS_FILE = path.resolve(process.cwd(), 'data', 'requests_store.json');

export class RequestsService {
  private getStore(): AttendanceRegularizationRequest[] {
    try {
      if (fs.existsSync(REQUESTS_FILE)) {
        const raw = fs.readFileSync(REQUESTS_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('Failed to read requests store:', err);
    }
    return [];
  }

  private saveStore(data: AttendanceRegularizationRequest[]): void {
    try {
      const dir = path.dirname(REQUESTS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(REQUESTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save requests store:', err);
    }
  }

  public getRequests(filter?: { empCode?: string; status?: string }): AttendanceRegularizationRequest[] {
    let list = this.getStore();
    if (filter?.empCode) {
      list = list.filter(r => r.empCode === filter.empCode);
    }
    if (filter?.status) {
      list = list.filter(r => r.status === filter.status);
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public createRequest(data: Omit<AttendanceRegularizationRequest, 'id' | 'status' | 'createdAt'>): AttendanceRegularizationRequest {
    const list = this.getStore();
    const newReq: AttendanceRegularizationRequest = {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      ...data,
      status: 'APPROVED', // Auto-approved for frictionless demo or configurable
      createdAt: new Date().toISOString(),
    };
    list.unshift(newReq);
    this.saveStore(list);
    return newReq;
  }

  public updateStatus(id: string, status: 'APPROVED' | 'REJECTED', reviewComment?: string): AttendanceRegularizationRequest | null {
    const list = this.getStore();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;

    list[idx] = {
      ...list[idx],
      status,
      reviewComment,
      reviewedAt: new Date().toISOString(),
    };

    this.saveStore(list);
    return list[idx];
  }

  public getLeaveBalance(empCode: string): LeaveBalance {
    // Default standard company leave policy: 12 CL, 12 SL, 15 EL
    const userReqs = this.getRequests({ empCode, status: 'APPROVED' });
    const usedCL = userReqs.filter(r => r.requestType === 'LEAVE' && r.leaveType === 'CASUAL_LEAVE').length;
    const usedSL = userReqs.filter(r => r.requestType === 'LEAVE' && r.leaveType === 'SICK_LEAVE').length;
    const usedEL = userReqs.filter(r => r.requestType === 'LEAVE' && r.leaveType === 'EARNED_LEAVE').length;

    return {
      casualLeave: Math.max(0, 12 - usedCL),
      sickLeave: Math.max(0, 12 - usedSL),
      earnedLeave: Math.max(0, 15 - usedEL),
      compOff: 2,
    };
  }
}

export const requestsService = new RequestsService();
