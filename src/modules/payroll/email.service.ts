import nodemailer from 'nodemailer';
import { EmployeePayrollSummary, PayslipLine } from './payroll.types.js';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const money = (n: number) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COMPANY_ADDRESS = 'Flat No: 43-44/345, 1st Main Road, Banashankari Layout, Bengaluru, Bengaluru Urban, Karnataka - 560049';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return `${MONTHS[(m || 1) - 1]}_${String(y).slice(-2)}`; };
const periodLabel = (month: string) => { const [y, m] = month.split('-').map(Number); return `${MONTHS[(m || 1) - 1]}- ${y}`; };
const dotDate = (iso?: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };

class EmailService {
  private transporter: any = null;

  constructor() {
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
      console.log('[EmailService] SMTP transporter initialized.');
    } else {
      console.log('[EmailService] Simulation mode (set SMTP_HOST, SMTP_USER, SMTP_PASS for live dispatch).');
    }
  }

  /**
   * Payslip email, laid out like the company payslip (PDF template). Every figure comes from the backend
   * payroll result; all text is HTML-escaped. Lines are grouped under the template's headings, and any line
   * without a heading is appended so the columns foot to the totals.
   */
  private generatePayslipHtml(s: EmployeePayrollSummary): string {
    const p = s.payslip;
    const EARN: [string, string[], number | undefined][] = [
      ['Basic Pay', ['BASIC'], s.basicSalary], ['VDA', ['DA'], s.da], ['HRA', ['HRA'], s.hra], ['LTA', [], undefined],
      ['Other Allowances', ['OTHER'], s.otherAllowance], ['Sunday working Allowance', ['WEEKLY_OFF_WORK', 'HOLIDAY_WORK', 'SUNDAY'], undefined],
      ['Conveyance', [], undefined], ['Increments-Re-Imbursements', [], undefined], [`incentive for ${shortMonth(s.month)}`, [], undefined],
      ['Other / Attn Bonus', [], undefined], ['Special Allowance', ['SPECIAL'], s.allowances],
    ];
    const DED: [string, string[]][] = [['ESI', ['ESI']], ['PF', ['PF']], ['PT', ['PT']], ['Salary Advance', []], ['Other deduction', []], ['LWF', []]];
    const group = (lines: PayslipLine[], heads: [string, string[]][]) => {
      const used = new Set<string>();
      const rows = heads.map(([label, codes]) => {
        const mine = lines.filter((l) => codes.includes(l.code));
        mine.forEach((l) => used.add(l.code));
        return { label, amount: Math.round(mine.reduce((a, l) => a + l.amount, 0) * 100) / 100 };
      });
      for (const l of lines) if (!used.has(l.code)) rows.push({ label: l.note ? `${l.label} (${l.note})` : l.label, amount: l.amount });
      return rows;
    };
    const earn = group(p.earnings, EARN.map(([l, c]) => [l, c]));
    const ded = group(p.deductions, DED);
    const n = Math.max(earn.length, ded.length);
    const cell = 'border-left:1px solid #000;border-right:1px solid #000;padding:2px 6px';
    const body = Array.from({ length: n }, (_, i) => {
      const e = earn[i]; const d = ded[i];
      return `<tr><td style="${cell}">${esc(e?.label ?? '')}</td><td style="${cell};text-align:right">${e ? esc(EARN[i]?.[2] ?? 0) : ''}</td><td style="${cell};text-align:right">${e ? esc(e.amount) : ''}</td>` +
        `<td style="${cell}">${esc(d?.label ?? '')}</td><td style="${cell};text-align:right">${d ? esc(d.amount) : ''}</td></tr>`;
    }).join('');
    const box = 'border:1px solid #000;padding:4px 6px;font-weight:bold';
    const info = (label: string, value: unknown) => `<tr><td style="padding:1px 0;width:55%">${esc(label)}</td><td style="width:14px">:</td><td style="font-weight:bold">${esc(value === undefined || value === '' ? '—' : value)}</td></tr>`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#000">
<div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #cbd5e1;padding:20px;font-size:13px">
  <div style="text-align:center"><div style="font-size:28px;font-weight:bold">COLOR MYLES</div>
  <div style="font-size:11px;margin-top:6px">${esc(COMPANY_ADDRESS)}</div>
  <div style="font-weight:bold;margin:12px 0">Pay Slip for the period of ${esc(periodLabel(s.month))}</div></div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
    ${info('Employee Id', s.empCode)}${info('Name', s.name)}${info('Date Of Joining', dotDate(s.doj))}${info('UAN number', s.uanNumber)}
    ${info('ESI IP Number', s.esiNumber || '0')}${info('Designation', s.designation)}${info('Total Days', s.monthDays)}
    ${info('Days of Worked', s.payableDays)}${info('Days Absent', s.lopDays)}
  </table>
  <table style="width:100%;border-collapse:collapse">
    <tr style="font-weight:bold"><td style="${box}">Earnings</td><td style="${box};text-align:right">Fixed Wages</td><td style="${box};text-align:right">Amount</td><td style="${box}">Deductions</td><td style="${box};text-align:right">Amount</td></tr>
    ${body}
    <tr style="background:#ffff00"><td style="${box}">Total Earnings</td><td style="${box};text-align:right">${esc(money(s.grossSalary))}</td><td style="${box};text-align:right">${esc(money(p.totalEarnings))}</td><td style="${box}">Total Deductions</td><td style="${box};text-align:right">${esc(money(p.totalDeductions))}</td></tr>
    <tr style="background:#fce4d6"><td style="${box}" colspan="2">Net Pay</td><td style="${box};text-align:right" colspan="3">${esc(money(p.netPay))}</td></tr>
  </table>
  <p style="margin:14px 0 2px"><strong>Amount in Words:</strong></p><div>${esc(s.netPayableWords)}</div>
  <p style="text-align:center;font-weight:bold;font-size:12px;margin-top:36px">Computer Generated, Signature Not Required</p>
</div></body></html>`;
  }

  public async sendPayslipEmail(
    summary: EmployeePayrollSummary,
    recipientEmail?: string
  ): Promise<{ success: boolean; message: string; sentTo: string; previewHtml?: string }> {
    const targetEmail = recipientEmail || summary.email;
    if (!targetEmail) {
      throw new Error(`No email address registered for employee ${summary.empCode}. Update their profile email first.`);
    }
    const htmlContent = this.generatePayslipHtml(summary);
    if (this.transporter) {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || '"ColorMyles HRMS" <payroll@colormyles.com>',
        to: targetEmail,
        subject: `ColorMyles Payslip, ${summary.month}`,
        html: htmlContent,
      });
      return { success: true, message: `Payslip dispatched to ${targetEmail}`, sentTo: targetEmail };
    }
    return {
      success: true,
      message: `Payslip generated for ${targetEmail} (simulation mode: configure SMTP for live delivery)`,
      sentTo: targetEmail,
      previewHtml: htmlContent,
    };
  }
}

export const emailService = new EmailService();
