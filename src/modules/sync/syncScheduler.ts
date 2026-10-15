import mongoose, { Schema } from 'mongoose';
import { randomUUID } from 'crypto';
import { syncService } from './sync.service.js';
import { policyService } from '../settings/policy.service.js';
import { ENV } from '../../config/env.js';
import { isDbConnected } from '../../config/db.js';
import { addDays, istToday } from '../../utils/istTime.js';

export interface SchedulerStatus {
  isRunning: boolean;
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  lastRunResult: any;
  errorCount: number;
  /** Whether THIS instance currently holds the cluster-wide scheduler lease. */
  holdsLease: boolean;
  instanceEnabled: boolean;
}

// Cluster-wide lease: only the instance holding it runs the cycle, so scaling the API to
// several instances never produces concurrent syncs.
const LeaseModel =
  mongoose.models.SchedulerLease ||
  mongoose.model('SchedulerLease', new Schema({ _id: String, owner: String, leaseUntil: Date }, { collection: 'scheduler_leases' }));

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private cycleRunning = false;
  private lastRunAt: string | null = null;
  private nextRunAt: string | null = null;
  private totalRuns = 0;
  private errorCount = 0;
  private lastRunResult: any = null;
  private holdsLease = false;
  private readonly instanceId = randomUUID();

  public init(): void {
    if (!ENV.SCHEDULER_ENABLED) {
      console.log('[SyncScheduler] Disabled on this instance (SCHEDULER_ENABLED=false).');
      return;
    }
    const s = policyService.getSettings().scheduler;
    if (s.enabled) this.start(s.intervalMinutes);
  }

  public start(intervalMinutes: number = 5): void {
    this.stop(false);
    if (!ENV.SCHEDULER_ENABLED) return;
    const ms = Math.max(1, intervalMinutes) * 60_000;
    this.active = true;
    this.schedule(ms, 10_000);
    console.log(`[SyncScheduler] Started: every ${intervalMinutes} minute(s).`);
  }

  public stop(log = true): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = false;
    this.nextRunAt = null;
    if (log) console.log('[SyncScheduler] Paused.');
  }

  /** setTimeout chain (not setInterval): the next cycle is only scheduled after the current one ends. */
  private schedule(intervalMs: number, firstDelayMs = intervalMs): void {
    if (!this.active) return;
    this.nextRunAt = new Date(Date.now() + firstDelayMs).toISOString();
    this.timer = setTimeout(async () => {
      try { await this.executeCycle(); } catch (e: any) { console.error('[SyncScheduler] cycle error:', e?.message); }
      const current = Math.max(1, policyService.getSettings().scheduler.intervalMinutes) * 60_000;
      this.schedule(current ?? intervalMs);
    }, firstDelayMs);
    this.timer.unref?.();
  }

  public async acquireLease(): Promise<boolean> {
    if (!isDbConnected()) return false;
    const now = new Date();
    const ttl = new Date(now.getTime() + Math.max(2, policyService.getSettings().scheduler.intervalMinutes * 2) * 60_000);
    try {
      const res = await LeaseModel.findOneAndUpdate(
        { _id: 'sync', $or: [{ owner: this.instanceId }, { leaseUntil: { $lt: now } }] },
        { $set: { owner: this.instanceId, leaseUntil: ttl } },
        { upsert: true, new: true }
      );
      return (res as any)?.owner === this.instanceId;
    } catch {
      return false; // duplicate key => another instance holds the lease
    }
  }

  public async triggerNow(): Promise<any> {
    return this.executeCycle(true);
  }

  public getStatus(): SchedulerStatus {
    const s = policyService.getSettings().scheduler;
    return {
      isRunning: this.active,
      enabled: s.enabled,
      intervalMinutes: s.intervalMinutes,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      totalRuns: this.totalRuns,
      lastRunResult: this.lastRunResult,
      errorCount: this.errorCount,
      holdsLease: this.holdsLease,
      instanceEnabled: ENV.SCHEDULER_ENABLED,
    };
  }

  /** Syncs yesterday + today (catches late vendor edits and overnight shifts) for both vendor APIs. */
  private async executeCycle(manual = false): Promise<any> {
    if (this.cycleRunning) return { skipped: 'previous cycle still running' };
    this.holdsLease = await this.acquireLease();
    if (!this.holdsLease && !manual) return { skipped: 'another instance holds the scheduler lease' };
    this.cycleRunning = true;
    this.lastRunAt = new Date().toISOString();
    try {
      const today = istToday();
      const opts = { fromDate: addDays(today, -1), toDate: today, triggeredBy: 'SCHEDULED' as const };
      const raw = await syncService.syncAll('RAW', opts);
      const inout = await syncService.syncAll('INOUT', opts);
      const ok = [...raw, ...inout].every((r) => r.success);
      this.totalRuns++;
      if (!ok) this.errorCount++;
      this.lastRunResult = {
        timestamp: this.lastRunAt,
        success: ok,
        raw: { fetched: raw.reduce((a, r) => a + r.fetched, 0), inserted: raw.reduce((a, r) => a + r.inserted, 0) },
        inOut: { fetched: inout.reduce((a, r) => a + r.fetched, 0), upserted: inout.reduce((a, r) => a + r.inserted, 0) },
        errors: [...raw, ...inout].filter((r) => !r.success).map((r) => `${r.sourceId}/${r.syncType}: ${r.error}`),
      };
      return this.lastRunResult;
    } catch (e: any) {
      this.errorCount++;
      this.lastRunResult = { timestamp: this.lastRunAt, success: false, errors: [e?.message || 'cycle failed'] };
      throw e;
    } finally {
      this.cycleRunning = false;
    }
  }
}

export const syncScheduler = new SyncScheduler();
