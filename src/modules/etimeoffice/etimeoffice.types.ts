export interface RawVendorPunchRecord {
  Name?: string;
  Empcode?: string;
  PunchDate: string;
  M_Flag?: string | null;
  mcid?: string | number | null;
  [key: string]: any;
}

export interface ETimeOfficePunchResponse {
  Error: boolean | string;
  Msg?: string;
  IsAdmin?: boolean;
  PunchData?: RawVendorPunchRecord[];
  [key: string]: any;
}

export interface RawInOutRecord {
  Empcode: string;
  Name?: string;
  DateString: string; // "dd/MM/yyyy" e.g. "15/09/2026"
  INTime?: string;     // "08:56" or "--:--"
  OUTTime?: string;    // "17:37" or "--:--"
  WorkTime?: string;   // "08:11" or "00:00"
  OverTime?: string;   // "00:00"
  BreakTime?: string;  // "00:00"
  Status?: string;     // "P", "P/2", "A", "W", "H", etc.
  Remark?: string;     // "MIS-LT", "--"
  Erl_Out?: string;    // "00:00"
  Late_In?: string;    // "02:36"
  [key: string]: any;
}

export interface ETimeOfficeInOutResponse {
  Error?: boolean | string;
  Msg?: string;
  IsAdmin?: boolean;
  InOutPunchData?: RawInOutRecord[];
  [key: string]: any;
}

export interface RawLastPunchRecord {
  Name?: string;
  Empcode: string;
  PunchDate: string;
  M_Flag?: string | null;
  ID?: number;
  Table?: string;
  EmpcardNo?: string;
}

export interface ETimeOfficeLastPunchResponse {
  Error?: boolean | string;
  Msg?: string;
  IsAdmin?: boolean;
  PunchData?: RawLastPunchRecord[];
  MaxRecord?: string;
  TableName?: string;
}

export interface FetchPunchDataParams {
  sourceId: string;
  fromDate?: string; // YYYY-MM-DD or dd/MM/yyyy_HH:mm
  toDate?: string;   // YYYY-MM-DD or dd/MM/yyyy_HH:mm
  empCode?: string;  // e.g. "ALL" or specific employee code
}

export interface FetchInOutParams {
  sourceId: string;
  fromDate: string; // YYYY-MM-DD or dd/MM/yyyy
  toDate: string;   // YYYY-MM-DD or dd/MM/yyyy
  empCode?: string; // default "ALL"
}

export interface ETimeOfficeClientResult {
  success: boolean;
  sourceId: string;
  sourceName: string;
  records: RawVendorPunchRecord[];
  requestFromDate: string;
  requestToDate: string;
  rawResponseMsg?: string;
}

export interface ETimeOfficeInOutResult {
  success: boolean;
  sourceId: string;
  sourceName: string;
  records: RawInOutRecord[];
  requestFromDate: string;
  requestToDate: string;
  rawResponseMsg?: string;
}
