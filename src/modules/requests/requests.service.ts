import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { AttendanceRegularizationRequest, LeaveBalance } from './requests.types.js';
import { policyService } from '../settings/policy.service.js';
import { localStore } from '../../config/localStore.js';
import { InOutModel } from '../attendance/inOut.model.js';

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
      status: 'PENDING', // Awaiting SuperAdmin / Founder approval
      createdAt: new Date().toISOString(),
    };
    list.unshift(newReq);
    this.saveStore(list);
    return newReq;
  }

  public async updateStatus(
    id: string, 
    status: 'APPROVED' | 'REJECTED', 
    reviewComment?: string,
    reviewedBy?: string
  ): Promise<AttendanceRegularizationRequest | null> {
    const list = this.getStore();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return null;

    const target = list[idx];
    target.status = status;
    target.reviewComment = reviewComment;
    target.reviewedBy = reviewedBy || 'Super Admin';
    target.reviewedAt = new Date().toISOString();

    this.saveStore(list);

    if (status === 'APPROVED') {
      try {
        const isDbConnected = mongoose.connection.readyState === 1;
        const recordKey = `office_${target.empCode}_${target.date}`;

        if (target.requestType === 'MISSED_PUNCH') {
          const inT = target.inTime || '09:00';
          const outT = target.outTime || '18:00';
          const inParts = inT.split(':').map(Number);
          const outParts = outT.split(':').map(Number);
          const wMin = Math.max(0, (outParts[0] * 60 + outParts[1]) - (inParts[0] * 60 + inParts[1]));
          const wHours = Math.floor(wMin / 60);
          const wMins = wMin % 60;
          const wTimeStr = `${String(wHours).padStart(2, '0')}:${String(wMins).padStart(2, '0')}`;

          const inOutPatch: any = {
            sourceId: 'office',
            sourceName: 'ColorMyles',
            employeeCode: target.empCode,
            employeeName: target.empName,
            date: target.date,
            inTime: inT,
            outTime: outT,
            workTime: wTimeStr,
            workMinutes: wMin,
            status: 'P',
            statusLabel: 'Present',
            remark: 'REGULARIZED',
            recordKey,
            syncedAt: new Date().toISOString(),
          };

          localStore.upsertInOutRecords([inOutPatch]);
          if (isDbConnected) {
            await InOutModel.updateOne(
              { recordKey },
              { $set: inOutPatch },
              { upsert: true }
            );
          }
        } else if (target.requestType === 'LEAVE') {
          const inOutPatch: any = {
            sourceId: 'office',
            sourceName: 'ColorMyles',
            employeeCode: target.empCode,
            employeeName: target.empName,
            date: target.date,
            inTime: '--:--',
            outTime: '--:--',
            workTime: '00:00',
            workMinutes: 0,
            status: 'L',
            statusLabel: 'Leave',
            remark: target.leaveType || 'LEAVE',
            recordKey,
            syncedAt: new Date().toISOString(),
          };

          localStore.upsertInOutRecords([inOutPatch]);
          if (isDbConnected) {
            await InOutModel.updateOne(
              { recordKey },
              { $set: inOutPatch },
              { upsert: true }
            );
          }
        }
      } catch (applyErr) {
        console.warn('[RequestsService] Could not auto-sync approved request to inOut records:', applyErr);
      }
    }

    return target;
  }

  public getLeaveBalance(empCode: string): LeaveBalance {
    const policy = policyService.getSettings();
    const quota = policy.leaves || { casualLeave: 12, sickLeave: 12, earnedLeave: 15, compOff: 2 };
    const userReqs = this.getRequests({ empCode, status: 'APPROVED' });
    const usedCL = userReqs.filter(r => r.requestType === 'LEAVE' && r.leaveType === 'CASUAL_LEAVE').length;
    const usedSL = userReqs.filter(r => r.requestType === 'LEAVE' && r.leaveType === 'SICK_LEAVE').length;
    const usedEL = userReqs.filter(r => r.requestType === 'LEAVE' && r.leaveType === 'EARNED_LEAVE').length;

    return {
      casualLeave: Math.max(0, (quota.casualLeave ?? 12) - usedCL),
      sickLeave: Math.max(0, (quota.sickLeave ?? 12) - usedSL),
      earnedLeave: Math.max(0, (quota.earnedLeave ?? 15) - usedEL),
      compOff: quota.compOff ?? 2,
    };
  }
}

export const requestsService = new RequestsService();
