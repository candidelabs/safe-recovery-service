import {SummaryMessageData} from "../../utils/interfaces";
import {escapeHtml} from "../../utils";

export type MessageTemplates = "otpVerification" | "notification";
const emailTemplates: Record<MessageTemplates, any> = {
  otpVerification: {
    subject: `{{subject}}`,
    body: `<!doctypehtml><meta charset=UTF-8><meta content="width=device-width,initial-scale=1" name=viewport><title>OTP Verification</title><style>body{font-family:Arial,sans-serif;background-color:#f4f4f4;margin:0;padding:0}.container{max-width:600px;margin:30px auto;background:#fff;padding:20px;border-radius:8px;box-shadow:0 0 10px rgba(0,0,0,.1);text-align:center}.header{background:#007bff;color:#fff;padding:15px;font-size:24px;border-top-left-radius:8px;border-top-right-radius:8px}.otp{font-size:24px;font-weight:700;background:#f8f9fa;display:inline-block;padding:10px 20px;border-radius:5px;margin:20px 0}.footer{margin-top:20px;font-size:12px;color:#777}</style><div class=container><div class=header>OTP Verification</div><p><br>Your one-time password (OTP) for verification is:<div class=otp>{{otp}}</div><p>This OTP is valid for 10 minutes. Do not share this code with anyone.<p>If you didn't request this, please ignore this email.</div>`,
    isHtml: true,
  },
  notification: {
    subject: `{{subject}}`,
    body: generateEventSummaryEmail,
    isHtml: true,
  }
};

const smsTemplates: Record<MessageTemplates, any> = {
  otpVerification: {
    body: `Your verification code for registering your account: {{otp}}`,
  },
  notification: {
    body: generateEventSummarySMS
  }
};

export function getTemplate(channel: string, template: MessageTemplates): Record<string, any> {
  if (channel === "email"){
    return emailTemplates[template];
  }
  if (channel === "sms"){
    return smsTemplates[template];
  }
  return emailTemplates[template];
}

//

function generateEventSummaryEmail(summaries: SummaryMessageData[]): string {
    const contents:string[] = summaries.map(summary => generateSingleEventSummaryEmail(summary));
    const compinedContent = contents.reduce((compinedContent, content) => compinedContent + content);
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Security Update</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container { padding: 10px !important; }
      h1 { font-size: 20px !important; }
      h2 { font-size: 16px !important; }
      pre, li { font-size: 12px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f0f0f0;">
  <div class="container" style="max-width: 600px; margin: 20px auto; background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #eee;">
      <h1 style="color: #1976d2; margin: 0; font-size: 24px;">Security Update</h1>
    </div>
    ${compinedContent} 
    <div style="text-align: center; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 12px;">
      <p style="margin: 0;">This is an automated security notification</p>
      <p style="margin: 5px 0;">For support, contact our team at support@example.com</p>
    </div>
  </div>
</body>
</html>
  `.trim();

}
function generateSingleEventSummaryEmail(summary: SummaryMessageData): string {
  // Critical section
  const criticalSection = summary.critical ? `
    <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 15px 0;">
      <h2 style="color: #c62828; margin: 0 0 10px 0; font-size: 18px;">
        === CRITICAL ===
      </h2>
      <pre style="white-space: pre-wrap; font-family: monospace; margin: 0; font-size: 14px; color: #333;">
        ${escapeHtml(summary.critical)}
      </pre>
    </div>
  ` : '';

  // Account changes
  const accountChangesSection = summary.accountChanges ? `
    <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
      <h2 style="color: #424242; margin: 0 0 10px 0; font-size: 18px;">
        === Guardian Changes ===
      </h2>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #333;">
        ${summary.accountChanges.map(detail => `
          <li style="margin: 5px 0;">
            <pre style="white-space: pre-wrap; font-family: monospace; margin: 0; display: inline;">
              ${escapeHtml(detail)}
            </pre>
          </li>
        `).join('')}
      </ul>
    </div>
  ` : '';

  return `
    <div style="padding: 20px 0;">
      <p style="color: #333; font-size: 16px; margin: 0 0 15px 0;">
        ${escapeHtml(summary.header)}
      </p>
      ${criticalSection}
      ${accountChangesSection}
      <hr>
    </div>
  `.trim();
}

export function generateEventSummarySMS(summaries: SummaryMessageData[]): string {
    const contents:string[] = summaries.map(summary => generateSingleEventSummarySMS(summary));
    const compinedContent = contents.reduce((compinedContent, content) => compinedContent + content);
    return compinedContent;
}
export function generateSingleEventSummarySMS(summary: SummaryMessageData): string {
  const headerMatch = summary.header.match(/on (\w+) \(chainId: (\d+)\)/);
  const network = headerMatch ? `${headerMatch[1]} (${headerMatch[2]})` : "Unknown";

  let message = `Security Update (${network}):`;

  // Critical section
  if (summary.critical) {
    const details = summary.critical
      .replace(/\n/g, "; ")
      .replace(/\s+/g, " ")
      .replace(/: /g, ":");
    message += `\nCRITICAL: ${details}`;
  }

  // Account changes section
  if (summary.accountChanges) {
    const details = summary.accountChanges
      .map(d => d.replace(/\n/g, ";"))
      .join(",");
    message += `\nGuardian Changes: ${details}\n`;
  }

  return message;
}