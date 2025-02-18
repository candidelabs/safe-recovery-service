export type MessageTemplates = "otpVerification";
const emailTemplates: Record<MessageTemplates, any> = {
  otpVerification: {
    subject: `{{subject}}`,
    body: `<!doctypehtml><meta charset=UTF-8><meta content="width=device-width,initial-scale=1" name=viewport><title>OTP Verification</title><style>body{font-family:Arial,sans-serif;background-color:#f4f4f4;margin:0;padding:0}.container{max-width:600px;margin:30px auto;background:#fff;padding:20px;border-radius:8px;box-shadow:0 0 10px rgba(0,0,0,.1);text-align:center}.header{background:#007bff;color:#fff;padding:15px;font-size:24px;border-top-left-radius:8px;border-top-right-radius:8px}.otp{font-size:24px;font-weight:700;background:#f8f9fa;display:inline-block;padding:10px 20px;border-radius:5px;margin:20px 0}.footer{margin-top:20px;font-size:12px;color:#777}</style><div class=container><div class=header>OTP Verification</div><p><br>Your one-time password (OTP) for verification is:<div class=otp>{{otp}}</div><p>This OTP is valid for 10 minutes. Do not share this code with anyone.<p>If you didn't request this, please ignore this email.</div>`,
    isHtml: true,
  }
};

const smsTemplates: Record<MessageTemplates, any> = {
  otpVerification: {
    body: `Your verification code for registering your account: {{otp}}`,
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
