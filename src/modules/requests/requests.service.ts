import mongoose from 'mongoose';
import { RequestModel } from './requests.model.js';
import { AttendanceRegularizationRequest, LeaveBalance } from './requests.types.js';
import { policyService } from '../settings/policy.service.js';
import { InOutModel } from '../attendance/inOut.model.js';

function toRequest(doc: any): AttendanceRegularizationRequest {
  const { _id, __v, createdAt, updatedAt, ...rest } = doc;
  return rest as AttendanceRegularizationRequest;
}

export class RequestsService {
  private assertDbConnected(): void {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Requests data requires an active database connection. Please try again shortly.');
    }
  }

  public async getRequests(filter?: { empCode?: string; status?: string }): Promise<AttendanceRegularizationRequest[]> {
    this.assertDbConnected();
    const query: any = {};
    if (filter?.empCode) query.empCode = filter.empCode;
    if (filter?.status) query.status = filter.status;

    const docs = await RequestModel.find(query).sort({ createdAt: -1 }).lean();
    return docs.map(toRequest);
  }

  public async createRequest(
    data: Omit<AttendanceRegularizationRequest, 'id' | 'status' | 'createdAt'>
  ): Promise<AttendanceRegularizationRequest> {
    this.assertDbConnected();
    const newReq: AttendanceRegularizationRequest = {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      ...data,
      status: 'PENDING', // Awaiting SuperAdmin / Founder approval
      createdAt: new Date().toISOString(),
    };
    await RequestModel.create(newReq);
    return newReq;
  }

  public async updateStatus(
    id: string,
    status: 'APPROVED' | 'REJECTED',
    reviewComment?: string,
    reviewedBy?: string
  ): Promise<AttendanceRegularizationRequest | null> {
    this.assertDbConnected();

    const updated = await RequestModel.findOneAndUpdate(
      { id },
      {
        $set: {
          status,
          reviewComment,
          reviewedBy: reviewedBy || 'Super Admin',
          reviewedAt: new Date().toISOString(),
        },
      },
      { new: true }
    ).lean();

    if (!updated) return null;
    const target = toRequest(updated);

    if (status === 'APPROVED') {
      try {
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

          await InOutModel.updateOne(
            { recordKey },
            {
              $set: {
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
                syncedAt: new Date(),
              },
            },
            { upsert: true }
          );
        } else if (target.requestType === 'LEAVE') {
          await InOutModel.updateOne(
            { recordKey },
            {
              $set: {
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
                syncedAt: new Date(),
              },
            },
            { upsert: true }
          );
        }
      } catch (applyErr) {
        console.warn('[RequestsService] Could not auto-sync approved request to inOut records:', applyErr);
      }
    }

    return target;
  }

  public async getLeaveBalance(empCode: string): Promise<LeaveBalance> {
    const policy = policyService.getSettings();
    const quota = policy.leaves || { casualLeave: 12, sickLeave: 12, earnedLeave: 15, compOff: 2 };
    const userReqs = await this.getRequests({ empCode, status: 'APPROVED' });
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
