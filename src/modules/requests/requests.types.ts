export interface AttendanceRegularizationRequest {
  id: string;
  empCode: string;
  empName: string;
  requestType: 'MISSED_PUNCH' | 'LEAVE' | 'WORK_FROM_HOME' | 'ON_DUTY';
  date: string;
  inTime?: string;
  outTime?: string;
  leaveType?: 'CASUAL_LEAVE' | 'SICK_LEAVE' | 'EARNED_LEAVE';
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
}

export interface LeaveBalance {
  casualLeave: number;
  sickLeave: number;
  earnedLeave: number;
  compOff: number;
}
