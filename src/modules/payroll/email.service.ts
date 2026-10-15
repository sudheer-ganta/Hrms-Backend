import nodemailer from 'nodemailer';
import { EmployeePayrollSummary } from './payroll.types.js';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const maskTail = (v?: string) => (v ? `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}` : '');

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

  /** Payslip email. Every figure comes from the backend payroll result; all text is HTML-escaped. */
  private generatePayslipHtml(s: EmployeePayrollSummary): string {
    const rows = (lines: { label: string; amount: number; note?: string }[]) =>
      lines.map((l) => `<tr><td style="padding:4px 8px">${esc(l.label)}${l.note ? ` <span style="color:#64748b;font-size:11px">(${esc(l.note)})</span>` : ''}</td><td style="padding:4px 8px;text-align:right">${inr(l.amount)}</td></tr>`).join('');
    const p = s.payslip;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1e293b">
<div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:#011638;color:#fff;padding:20px;text-align:center"><h2 style="margin:0">ColorMyles HRMS</h2>
  <div style="font-size:13px;color:#94a3b8">Salary Payslip, ${esc(s.month)}</div></div>
  <div style="padding:20px">
    <p>Dear <strong>${esc(s.name)}</strong> (Emp ID: <strong>${esc(s.empCode)}</strong>),</p>
    <p style="font-size:13px">Paid days: <strong>${esc(s.payableDays)}</strong> of ${esc(s.monthDays)}. Loss of pay: <strong>${esc(s.lopDays)}</strong> day(s).</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#ecfdf5"><th style="text-align:left;padding:6px 8px">Earnings</th><th style="text-align:right;padding:6px 8px">₹</th></tr>
      ${rows(p.earnings)}
      <tr style="font-weight:bold"><td style="padding:6px 8px">Total earnings</td><td style="padding:6px 8px;text-align:right">${inr(p.totalEarnings)}</td></tr>
      <tr style="background:#fef2f2"><th style="text-align:left;padding:6px 8px">Deductions</th><th style="text-align:right;padding:6px 8px">₹</th></tr>
      ${rows(p.deductions)}
      <tr style="font-weight:bold"><td style="padding:6px 8px">Total deductions</td><td style="padding:6px 8px;text-align:right">${inr(p.totalDeductions)}</td></tr>
    </table>
    <div style="background:#011638;color:#fff;border-radius:10px;text-align:center;padding:16px;margin:18px 0">
      <div style="font-size:12px;opacity:.85">NET PAYABLE</div>
      <div style="font-size:26px;font-weight:800">${inr(p.netPay)}</div>
      <div style="font-size:12px;opacity:.85">${esc(s.netPayableWords)}</div>
    </div>
    <p style="font-size:12px;color:#475569">${s.bankAccount ? `Bank A/C: ${esc(maskTail(s.bankAccount))}` : ''}</p>
  </div>
  <div style="background:#f1f5f9;padding:12px;text-align:center;font-size:12px;color:#64748b">System-generated payslip. For discrepancies contact HR/Accounts.</div>
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
