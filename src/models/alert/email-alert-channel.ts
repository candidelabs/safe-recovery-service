import { AlertChannel } from "./alert-channel";
import nodemailer, {Transporter} from "nodemailer";
import {ethers} from "ethers";
import {getTemplate, MessageTemplates} from "./message-templates";
import Logger from "../../utils/logger";
import ky from "ky";
import {SmtpConfig, WebhookConfig} from "../../utils/interfaces";


export class EmailAlertChannel extends AlertChannel {
  private smtp?: SmtpConfig;
  private transporter?: Transporter;
  private webhook?: WebhookConfig;

  constructor(alertId: string, smtp: SmtpConfig | undefined, webhookConfig: WebhookConfig | undefined) {
    super(alertId, "email");
    if (smtp){
      this.smtp = smtp;
      this.transporter = nodemailer.createTransport({
        // @ts-ignore
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: {
          type: smtp.auth.type,
          user: smtp.auth.user,
          pass: smtp.auth.pass,
          accessToken: smtp.auth.accessToken,
        },
      });
    }
    if (webhookConfig){
      this.webhook = webhookConfig;
    }
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

  async sendMessage(templateId: MessageTemplates, target: string, templateOverrides?: Record<string, any>): Promise<boolean> {
    try {
      const template = getTemplate("email", templateId);
      if (!template) {
        Logger.error(`Email Channel (${this.alertId}): Message Template "${templateId}" not found.`);
        return false;
      }
      let subject: string;
      let body: string;
      subject = template.subject;
      if (typeof template.body === "function"){
        if (templateOverrides) {
          body = template.body(templateOverrides.argumentData)
        }else{
          body = template.body();
        }
      }else{
        body = template.body;
      }
      if (templateOverrides) {
        for (const [key, value] of Object.entries(templateOverrides)) {
          if (key == "argumentData") continue;
          subject = subject.replace(new RegExp(`{{${key}}}`, "g"), value);
          body = body.replace(new RegExp(`{{${key}}}`, "g"), value);
        }
      }
      if (this.transporter){
        const info = await this.transporter.sendMail({
          from: this.smtp!.from,
          to: target,
          subject: subject,
          [template.isHtml ? "html" : "text"]: body,
        });

        return (info.accepted as string[]).length > 0;
      }else{
        const headers: Record<string, string> = {};
        if (this.webhook!.authorizationHeader){
          headers["Authorization"] = this.webhook!.authorizationHeader;
        }
        const webhookPayload = {
          channel: "email",
          target: target,
          subject: subject,
          [template.isHtml ? "html" : "text"]: body,
        };
        const response = await ky.post(this.webhook!.endpoint, {json: webhookPayload, headers});
        if (response.status >= 200 && response.status < 300) {
          return true;
        } else {
          Logger.error(
            `Email Channel (${this.alertId}): Webhook failed with status ${response.status}`
          );
          return false;
        }
      }
    } catch (error) {
      Logger.error(`Email Channel (${this.alertId}): Error sending email, ${error}`);
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (this.transporter){
        await this.transporter.verify();
      }else{
        const headers: Record<string, string> = {};
        if (this.webhook!.authorizationHeader){
          headers["Authorization"] = this.webhook!.authorizationHeader;
        }
        const response = await ky.get(this.webhook!.endpoint, {
          searchParams: {"channel": "email"},
          headers
        });
        return response.status >= 200 && response.status < 300;
      }
      return true;
    } catch (error) {
      Logger.error(`Email Channel (${this.alertId}): health check failed, ${error}`);
      return false;
    }
  }
}
