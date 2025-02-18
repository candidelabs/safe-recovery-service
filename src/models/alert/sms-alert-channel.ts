import { AlertChannel } from "./alert-channel";
import twilio, { Twilio } from "twilio";
import {ethers} from "ethers";
import {getTemplate, MessageTemplates} from "./message-templates";

export class SMSAlertChannel extends AlertChannel {
  private twilioClient: Twilio;
  private readonly fromNumber: string;

  constructor(alertId: string, accountSid: string, authToken: string, fromNumber: string) {
    super(alertId, "sms");
    this.alertId = alertId;
    this.twilioClient = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
  }

  async sanitizeTarget(target: string): Promise<string | undefined> {
    // Remove all non-numeric characters except "+"
    let sanitizedPhone = target.trim().replace(/[^0-9+]/g, "");
    // Ensure it starts with "+" and has 10-15 digits (E.164 format)
    const phoneRegex = /^\+?[1-9]\d{9,14}$/;
    return phoneRegex.test(sanitizedPhone) ? sanitizedPhone : undefined;
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
      const template = getTemplate("sms", templateId);
      if (!template) {
        console.error(`SMS Channel (${this.alertId}): Message Template "${templateId}" not found.`);
        return false;
      }
      let body = template.body;
      if (templateOverrides) {
        for (const [key, value] of Object.entries(templateOverrides)) {
          body = body.replace(new RegExp(`{{${key}}}`, "g"), value);
        }
      }
      const message = await this.twilioClient.messages.create({
        body: body,
        from: this.fromNumber,
        to: target,
      });
      if (message.errorCode !== null){
        console.error(`SMS Channel (${this.alertId}): failed to send message, ${message.errorCode}, ${message.errorMessage}`);
        return false;
      }
      return true;
    } catch (error) {
      console.error(`SMS Channel (${this.alertId}): failed to send message, ${error}`);
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.twilioClient.api.accounts(this.twilioClient.accountSid).fetch();
      return true;
    } catch (error) {
      console.error(`SMS Channel (${this.alertId}): health check failed, ${error}`);
      return false;
    }
  }
}
