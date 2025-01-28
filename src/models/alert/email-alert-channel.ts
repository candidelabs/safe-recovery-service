import { AlertChannel } from "./alert-channel";
import nodemailer, {Transporter} from "nodemailer";

export interface SmtpConfig {
  from: string;
  //
  host: string;
  port: number;
  secure: boolean;
  auth: {
    type: 'oauth2' | 'login';
    user: string;
    pass?: string;
    accessToken?: string
  }
}

export class EmailAlertChannel extends AlertChannel {
  private smtpConfig: SmtpConfig;
  private transporter: Transporter;

  constructor(alertId: string, smtpConfig: SmtpConfig) {
    super(alertId);
    this.smtpConfig = smtpConfig;
    this.transporter = nodemailer.createTransport({
      // @ts-ignore
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        type: smtpConfig.auth.type,
        user: smtpConfig.auth.user,
        pass: smtpConfig.auth.pass,
        accessToken: smtpConfig.auth.accessToken,
      },
    });
  }

  async sendMessage(target: string, subject: string, content: string): Promise<boolean> {
    try {
      const info = await this.transporter.sendMail({
        from: this.smtpConfig.from,
        to: target,
        subject: subject,
        html: `<p>${content}</p>`,
      });
      return (info.accepted as string[]).length > 0;
    } catch (error) {
      console.error(`Email Channel (${this.alertId}): error sending email, ${error}`);
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      console.error(`Email Channel (${this.alertId}): health check failed, ${error}`);
      return false;
    }
  }
}
