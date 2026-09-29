import nodemailer from 'nodemailer';
import { EmployeePayrollSummary } from './payroll.types.js';

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
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
      });
      console.log('[EmailService] SMTP Transporter initialized successfully with:', host);
    } else {
      console.log('[EmailService] Running in simulation mode (set SMTP_HOST, SMTP_USER, SMTP_PASS in .env for live dispatch)');
    }
  }

  /**
   * Generates a sleek branded HTML email template for ColorMyles Payslip
   */
  private generatePayslipHtml(summary: EmployeePayrollSummary): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Open Sans', Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
          .header { background: #011638; padding: 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
          .header p { margin: 6px 0 0 0; font-size: 13px; color: #94a3b8; }
          .content { padding: 24px; }
          .badge { display: inline-block; background: #e0f2fe; color: #0284c7; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
          .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
          .stat-title { font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 600; }
          .stat-value { font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          .salary-banner { background: linear-gradient(135deg, #1184b0, #011638); color: white; padding: 18px; border-radius: 10px; text-align: center; margin: 20px 0; }
          .salary-banner .amt { font-size: 28px; font-weight: 800; }
          .footer { background: #f1f5f9; padding: 16px; text-align: center; font-size: 12px; color: #64748b; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>ColorMyles HRMS</h1>
            <p>Official Monthly Salary Payslip — ${summary.month}</p>
          </div>
          <div class="content">
            <p>Dear <strong>${summary.name}</strong> (Emp ID: <strong>${summary.empCode}</strong>),</p>
            <p>Your official salary computation for the month of <strong>${summary.month}</strong> is finalized. Below is a summary of your attendance and earnings:</p>
            
            <div class="grid">
              <div class="stat-box">
                <div class="stat-title">Month Days / Payable</div>
                <div class="stat-value">${summary.monthDays} Days / ${summary.payableDays} Paid</div>
              </div>
              <div class="stat-box">
                <div class="stat-title">Loss of Pay (LOP)</div>
                <div class="stat-value" style="color: #ef4444;">${summary.lopDays} Days</div>
              </div>
              <div class="stat-box">
                <div class="stat-title">Standard Work Hours</div>
                <div class="stat-value">${summary.totalWorkHours} hrs</div>
              </div>
              <div class="stat-box">
                <div class="stat-title">Overtime (OT) Logged</div>
                <div class="stat-value" style="color: #10b981;">+${summary.totalOtHours} hrs (₹${summary.otEarnings})</div>
              </div>
              ${(summary.sundayEarnings ?? 0) > 0 ? `<div class="stat-box">
                <div class="stat-title">Sunday Working</div>
                <div class="stat-value" style="color: #10b981;">${summary.sundayDays} day(s) (₹${summary.sundayEarnings})</div>
              </div>` : ''}
            </div>

            <div class="salary-banner">
              <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.9;">Net Payable Salary</div>
              <div class="amt">₹${summary.netPayable.toLocaleString('en-IN')}</div>
              <div style="font-size: 12px; margin-top: 4px; opacity: 0.85;">${summary.netPayableWords}</div>
            </div>

            <p style="font-size: 13px; color: #475569;">
              <strong>Department:</strong> ${summary.department} | <strong>Location:</strong> ${summary.location}<br/>
              ${summary.dob ? `<strong>DOB:</strong> ${summary.dob} | ` : ''}
              ${summary.bankAccount ? `<strong>Bank A/C:</strong> ${summary.bankAccount}` : ''}
            </p>
          </div>
          <div class="footer">
            This is an automated system generated payslip from ColorMyles HRMS.<br/>
            For any payroll discrepancies, please contact the HR/Accounts department.
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Sends or simulates sending a payslip email to an employee
   */
  public async sendPayslipEmail(
    summary: EmployeePayrollSummary,
    recipientEmail?: string
  ): Promise<{ success: boolean; message: string; sentTo: string; previewHtml?: string }> {
    const targetEmail = recipientEmail || summary.email;

    if (!targetEmail) {
      throw new Error(`No email address registered for employee ${summary.name} (${summary.empCode}). Please update their profile email first.`);
    }

    const htmlContent = this.generatePayslipHtml(summary);

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: process.env.SMTP_FROM || '"ColorMyles HRMS" <payroll@colormyles.com>',
          to: targetEmail,
          subject: `ColorMyles Official Payslip — ${summary.month} (${summary.name})`,
          html: htmlContent
        });

        return {
          success: true,
          message: `Payslip email successfully dispatched to ${targetEmail}`,
          sentTo: targetEmail
        };
      } catch (err: any) {
        console.error('[EmailService] SMTP Dispatch failed:', err);
        throw new Error(`SMTP Dispatch failed: ${err.message}`);
      }
    } else {
      // In simulation mode, return success with preview
      return {
        success: true,
        message: `Payslip email successfully generated & queued for ${targetEmail} (Simulation Mode - configure SMTP in .env for production)`,
        sentTo: targetEmail,
        previewHtml: htmlContent
      };
    }
  }
}

export const emailService = new EmailService();
