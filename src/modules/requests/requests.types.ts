export const REQUEST_TYPES = ['MISSED_PUNCH', 'LEAVE', 'WORK_FROM_HOME', 'ON_DUTY'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const LEAVE_TYPES = ['CASUAL_LEAVE', 'SICK_LEAVE', 'EARNED_LEAVE', 'COMP_OFF', 'UNPAID_LEAVE'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * PENDING ──approve──▶ APPROVED ──apply──▶ APPLIED ──revoke──▶ REVOKED
 *    │
 *    ├──reject──▶ REJECTED        PENDING ──cancel──▶ CANCELLED
 * An APPROVED/APPLIED request can only be undone through an explicit REVOKE.
 */
export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED', 'REVOKED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Requests that hold attendance/leave effect (or will, once applied). */
export const ACTIVE_STATUSES: readonly RequestStatus[] = ['PENDING', 'APPROVED', 'APPLIED'];
export const EFFECTIVE_STATUSES: readonly RequestStatus[] = ['APPROVED', 'APPLIED'];

export interface AttendanceRegularizationRequest {
  id: string;
  empCode: string;
  empName: string;
  requestType: RequestType;
  date: string;          // first (or only) business date
  endDate?: string;      // inclusive end for multi-day LEAVE / WFH / ON_DUTY
  halfDay?: boolean;     // single-day LEAVE only
  days?: number;         // leave days actually deducted (weekly offs and paid holidays excluded)
  leaveYear?: number;
  inTime?: string;
  outTime?: string;
  leaveType?: LeaveType;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComment?: string;
  appliedAt?: string;
  applyError?: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
}

export interface LeaveBalanceEntry {
  quota: number;
  used: number;       // APPROVED / APPLIED
  pending: number;    // PENDING (informational, not deducted)
  available: number;  // quota - used
}

export interface LeaveBalance {
  empCode: string;
  year: number;
  balances: Record<Exclude<LeaveType, 'UNPAID_LEAVE'>, LeaveBalanceEntry>;
}
