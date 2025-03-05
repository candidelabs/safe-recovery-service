import { AlertChannel } from "./alert-channel";
import nodemailer, {Transporter} from "nodemailer";
import {ethers} from "ethers";
import {getTemplate, MessageTemplates} from "./message-templates";
import Logger from "../../utils/logger";

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
    super(alertId, "email");
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

  async sanitizeTarget(target: string): Promise<string | undefined> {
    const sanitizedEmail = target.trim().toLowerCase();
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(sanitizedEmail) ? sanitizedEmail : undefined;
  }

  async maskTarget(target: string): Promise<string> {
    const [localPart, domain] = target.split('@');
    const [domainName, domainExt] = domain.split('.');
    const maskedLocal = localPart.length <= 2 ? localPart : localPart[0] + '*'.repeat(localPart.length - 2) + localPart[localPart.length - 1];
    const maskedDomain = domainName.length <= 1 ? domainName : domainName[0] + '*'.repeat(domainName.length - 1);
    return `${maskedLocal}@${maskedDomain}.${domainExt}`;
  }

  async generateChallenge(seed: string): Promise<[string, string]> {
    const otp = Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map(num => (num % 10).toString())
      .join("");
    return [otp, ethers.utils.id(seed+otp)];
  }

  async verifyChallenge(challenge: string, hashedChallenge: string, seed: string): Promise<boolean> {
    return ethers.utils.id(seed + challenge) === hashedChallenge;
  }

  async sendMessage(templateId: MessageTemplates, target: string, templateOverrides?: Record<string, string>): Promise<boolean> {
    try {
      const template = getTemplate("email", templateId);
      if (!template) {
        Logger.error(`Email Channel (${this.alertId}): Message Template "${templateId}" not found.`);
        return false;
      }
      let subject = template.subject;
      let body = template.body;
      if (templateOverrides) {
        for (const [key, value] of Object.entries(templateOverrides)) {
          subject = subject.replace(new RegExp(`{{${key}}}`, "g"), value);
          body = body.replace(new RegExp(`{{${key}}}`, "g"), value);
        }
      }
      const info = await this.transporter.sendMail({
        from: this.smtpConfig.from,
        to: target,
        subject: subject,
        [template.isHtml ? "html" : "text"]: body,
      });

      return (info.accepted as string[]).length > 0;
    } catch (error) {
      Logger.error(`Email Channel (${this.alertId}): Error sending email, ${error}`);
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      Logger.error(`Email Channel (${this.alertId}): health check failed, ${error}`);
      return false;
    }
  }
}
