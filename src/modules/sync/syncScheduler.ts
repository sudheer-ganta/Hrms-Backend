import { syncService } from './sync.service.js';
import { inOutService } from '../attendance/inOut.service.js';
import { getTodayDateString } from '../../utils/dateUtils.js';
import { policyService } from '../settings/policy.service.js';

export interface SchedulerStatus {
  isRunning: boolean;
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  lastRunResult: any;
  errorCount: number;
}

class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastRunAt: string | null = null;
  private nextRunAt: string | null = null;
  private totalRuns: number = 0;
  private errorCount: number = 0;
  private lastRunResult: any = null;

  public init(): void {
    const settings = policyService.getSettings();
    if (settings.scheduler.enabled) {
      this.start(settings.scheduler.intervalMinutes);
    }
  }

  public start(intervalMinutes: number = 5): void {
    this.stop();
    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    this.isRunning = true;
    this.scheduleNextRun(intervalMs);

    console.log(`[SyncScheduler] Started background auto-sync every ${intervalMinutes} minute(s).`);

    // Run initial background sync after 10 seconds of startup
    setTimeout(() => {
      this.executeSyncCycle().catch((e) => console.warn('[SyncScheduler] Initial sync warning:', e.message));
    }, 10000);

    this.timer = setInterval(() => {
      this.executeSyncCycle().catch((e) => console.error('[SyncScheduler] Sync cycle error:', e.message));
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.nextRunAt = null;
    console.log('[SyncScheduler] Auto-sync scheduler paused.');
  }

  public async triggerNow(): Promise<any> {
    return this.executeSyncCycle();
  }

  public getStatus(): SchedulerStatus {
    const settings = policyService.getSettings();
    return {
      isRunning: this.isRunning,
      enabled: settings.scheduler.enabled,
      intervalMinutes: settings.scheduler.intervalMinutes,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      totalRuns: this.totalRuns,
      lastRunResult: this.lastRunResult,
      errorCount: this.errorCount,
    };
  }

  private scheduleNextRun(intervalMs: number): void {
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  }

  private async executeSyncCycle(): Promise<any> {
    const today = getTodayDateString();
    this.lastRunAt = new Date().toISOString();
    const settings = policyService.getSettings();
    this.scheduleNextRun(settings.scheduler.intervalMinutes * 60 * 1000);

    try {
      console.log(`[SyncScheduler] Running scheduled biometric punch sync for ${today}...`);
      const results = await syncService.syncAllSources({
        fromDate: today,
        toDate: today,
        triggeredBy: 'SCHEDULED',
      });
      const allSuccess = results.every(r => r.success);
      const totalFetched = results.reduce((acc, r) => acc + r.fetched, 0);
      const totalInserted = results.reduce((acc, r) => acc + r.inserted, 0);

      // Also refresh daily check-in/out & working-hours data on the same cadence,
      // so it doesn't go stale between manual syncs from the UI.
      let inOutSuccess = true;
      let inOutTotal = 0;
      try {
        console.log(`[SyncScheduler] Running scheduled daily attendance (IN/OUT) sync for ${today}...`);
        const inOutResult = await inOutService.syncAllLocationsInOut({
          fromDate: today,
          toDate: today,
          triggeredBy: 'SCHEDULED',
        });
        inOutSuccess = inOutResult.success;
        inOutTotal = inOutResult.totalCount;
      } catch (inOutError: any) {
        inOutSuccess = false;
        console.warn('[SyncScheduler] Daily attendance sync warning:', inOutError.message);
      }

      this.totalRuns++;
      this.lastRunResult = {
        timestamp: this.lastRunAt,
        success: allSuccess && inOutSuccess,
        totals: { fetched: totalFetched, inserted: totalInserted },
        dailyAttendance: { success: inOutSuccess, totalCount: inOutTotal },
      };
      return this.lastRunResult;
    } catch (error: any) {
      this.errorCount++;
      this.lastRunResult = {
        timestamp: this.lastRunAt,
        success: false,
        error: error.message || 'Auto-sync failed',
      };
      throw error;
    }
  }
}

export const syncScheduler = new SyncScheduler();
