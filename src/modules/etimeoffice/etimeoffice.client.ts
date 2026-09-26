import axios, { AxiosInstance, AxiosError } from 'axios';
import { ENV, getSourceById, SourceCredential } from '../../config/env.js';
import { 
  formatForETimeofficeRequest, 
  formatForETimeofficeInOutRequest, 
  getTodayDateString 
} from '../../utils/dateUtils.js';
import { 
  ETimeOfficePunchResponse, 
  ETimeOfficeInOutResponse,
  ETimeOfficeLastPunchResponse,
  FetchPunchDataParams, 
  FetchInOutParams,
  ETimeOfficeClientResult,
  ETimeOfficeInOutResult
} from './etimeoffice.types.js';

export class ETimeOfficeClient {
  private axiosInstance: AxiosInstance;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: ENV.ETIMESOURCE_BASE_URL,
      timeout: 45000, // 45s timeout for large date ranges
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'e-TimeHR-HMS-Portal/1.0',
      },
    });
  }

  /**
   * Builds the Base64 Basic Authentication header value required by e-Timeoffice:
   * Format: Corporateid:Username:Password:True
   */
  public static buildAuthHeader(credential: SourceCredential): string {
    const rawAuthString = `${credential.corporateId}:${credential.username}:${credential.password}:True`;
    const base64Auth = Buffer.from(rawAuthString).toString('base64');
    return `Basic ${base64Auth}`;
  }

  /**
   * Retries a vendor request once on transient network failures (timeouts, connection
   * resets) before giving up. Auth/validation errors are not retried since a second
   * attempt won't change the outcome. e-Timeoffice has intermittently timed out on
   * individual locations while others succeed, so a single retry meaningfully reduces
   * false "0 records" results without masking real, persistent failures.
   */
  private static isTransientNetworkError(err: any): boolean {
    if (!axios.isAxiosError(err)) return false;
    if (err.response) return false; // Got a real HTTP response — not a network-level issue
    const transientCodes = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'];
    return transientCodes.includes(err.code || '') || /timeout/i.test(err.message || '');
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (retries > 0 && ETimeOfficeClient.isTransientNetworkError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return this.withRetry(fn, retries - 1);
      }
      throw err;
    }
  }

  /**
   * API 2 — Downloads punch data with Machine ID (MCID)
   */
  public async fetchPunchDataMCID(params: FetchPunchDataParams): Promise<ETimeOfficeClientResult> {
    const { sourceId, fromDate, toDate, empCode = 'ALL' } = params;
    
    const source = getSourceById(sourceId);
    if (!source) {
      throw new Error(`Invalid source identifier "${sourceId}".`);
    }

    if (!source.corporateId || !source.username || !source.password) {
      throw new Error(
        `Credentials for source "${source.displayName}" (${source.id}) are missing or incomplete in environment variables.`
      );
    }

    const today = getTodayDateString();
    const formattedFromDate = formatForETimeofficeRequest(fromDate || today, '00:00');
    const formattedToDate = formatForETimeofficeRequest(toDate || today, '23:59');

    const authHeader = ETimeOfficeClient.buildAuthHeader(source);

    try {
      const response = await this.withRetry(() =>
        this.axiosInstance.get<ETimeOfficePunchResponse>('/DownloadPunchDataMCID', {
          headers: { 'Authorization': authHeader },
          params: {
            Empcode: empCode,
            FromDate: formattedFromDate,
            ToDate: formattedToDate,
          },
        })
      );

      const responseData = response.data;

      if (responseData && (responseData.Error === true || responseData.Error === 'true')) {
        if (responseData.Msg && /no\s*record/i.test(responseData.Msg)) {
          return {
            success: true,
            sourceId: source.id,
            sourceName: source.displayName,
            records: [],
            requestFromDate: formattedFromDate,
            requestToDate: formattedToDate,
            rawResponseMsg: responseData.Msg,
          };
        }
        throw new Error(responseData.Msg || 'e-Timeoffice returned an error status');
      }

      const punchRecords = Array.isArray(responseData?.PunchData) 
        ? responseData.PunchData 
        : [];

      return {
        success: true,
        sourceId: source.id,
        sourceName: source.displayName,
        records: punchRecords,
        requestFromDate: formattedFromDate,
        requestToDate: formattedToDate,
        rawResponseMsg: responseData?.Msg || 'Success',
      };
    } catch (err: any) {
      this.handleVendorApiError(err, source.displayName);
    }
  }

  /**
   * API 3 — Downloads IN/OUT Attendance with Check-In, Check-Out, Work Time, Overtime, Late In, Status
   */
  public async fetchInOutPunchData(params: FetchInOutParams): Promise<ETimeOfficeInOutResult> {
    const { sourceId, fromDate, toDate, empCode = 'ALL' } = params;

    const source = getSourceById(sourceId);
    if (!source) {
      throw new Error(`Invalid source identifier "${sourceId}".`);
    }

    if (!source.corporateId || !source.username || !source.password) {
      throw new Error(
        `Credentials for source "${source.displayName}" (${source.id}) are missing or incomplete in environment variables.`
      );
    }

    const formattedFromDate = formatForETimeofficeInOutRequest(fromDate);
    const formattedToDate = formatForETimeofficeInOutRequest(toDate);

    const authHeader = ETimeOfficeClient.buildAuthHeader(source);

    try {
      const response = await this.withRetry(() =>
        this.axiosInstance.get<ETimeOfficeInOutResponse>('/DownloadInOutPunchData', {
          headers: { 'Authorization': authHeader },
          params: {
            Empcode: empCode || 'ALL',
            FromDate: formattedFromDate,
            ToDate: formattedToDate,
          },
        })
      );

      const responseData = response.data;

      if (responseData && (responseData.Error === true || responseData.Error === 'true')) {
        if (responseData.Msg && /no\s*record/i.test(responseData.Msg)) {
          return {
            success: true,
            sourceId: source.id,
            sourceName: source.displayName,
            records: [],
            requestFromDate: formattedFromDate,
            requestToDate: formattedToDate,
            rawResponseMsg: responseData.Msg,
          };
        }
        throw new Error(responseData.Msg || 'e-Timeoffice returned an error status');
      }

      const inOutRecords = Array.isArray(responseData?.InOutPunchData) 
        ? responseData.InOutPunchData 
        : [];

      return {
        success: true,
        sourceId: source.id,
        sourceName: source.displayName,
        records: inOutRecords,
        requestFromDate: formattedFromDate,
        requestToDate: formattedToDate,
        rawResponseMsg: responseData?.Msg || 'Success',
      };
    } catch (err: any) {
      this.handleVendorApiError(err, source.displayName);
    }
  }

  /**
   * API 4 — Downloads incremental latest punch data using LastRecord watermark (MMyyyy$ID)
   */
  public async fetchLastPunchData(params: { sourceId: string; lastRecord: string; empCode?: string }) {
    const { sourceId, lastRecord, empCode = 'ALL' } = params;
    const source = getSourceById(sourceId);
    if (!source) throw new Error(`Invalid source identifier "${sourceId}".`);

    const authHeader = ETimeOfficeClient.buildAuthHeader(source);
    try {
      const response = await this.axiosInstance.get<ETimeOfficeLastPunchResponse>('/DownloadLastPunchData', {
        headers: { 'Authorization': authHeader },
        params: {
          Empcode: empCode,
          LastRecord: lastRecord,
        },
      });
      return response.data;
    } catch (err: any) {
      this.handleVendorApiError(err, source.displayName);
    }
  }

  /**
   * Centralized safe error translation for e-Timeoffice API errors.
   */
  private handleVendorApiError(error: any, sourceDisplayName: string): never {
    if (axios.isAxiosError(error)) {
      const axiosErr = error as AxiosError<any>;
      const status = axiosErr.response?.status;
      const responseData = axiosErr.response?.data;

      if (status === 401) {
        throw new Error(
          `Authentication failed for "${sourceDisplayName}". Please verify the e-Timeoffice Corporate ID, Username, and Password in configuration.`
        );
      }

      if (status === 400) {
        const detail = responseData?.Msg || responseData?.message || 'Invalid parameters supplied';
        throw new Error(`e-Timeoffice Bad Request (400) for "${sourceDisplayName}": ${detail}`);
      }

      if (status === 404) {
        throw new Error(`e-Timeoffice endpoint not found (404) at ${ENV.ETIMESOURCE_BASE_URL}`);
      }

      if (status && status >= 500) {
        throw new Error(`e-Timeoffice remote server error (${status}) for "${sourceDisplayName}". Please retry in a few moments.`);
      }

      if (axiosErr.code === 'ECONNABORTED' || axiosErr.message.includes('timeout')) {
        throw new Error(`Connection timeout (45s) while reaching e-Timeoffice for "${sourceDisplayName}". Try a smaller date range.`);
      }

      if (axiosErr.code === 'ENOTFOUND' || axiosErr.code === 'ECONNREFUSED') {
        throw new Error(`Unable to reach e-Timeoffice host at ${ENV.ETIMESOURCE_BASE_URL}. Check network connection or DNS.`);
      }
    }

    throw new Error(error?.message || `Unknown error interacting with e-Timeoffice for "${sourceDisplayName}"`);
  }
}

export const etimeofficeClient = new ETimeOfficeClient();
