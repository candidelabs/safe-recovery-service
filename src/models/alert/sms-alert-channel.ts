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
    if (!target || target.trim().length === 0) {
      return undefined;
    }
    // Remove any whitespace, hyphens, parentheses, and dots
    let sanitizedNumber = target.replace(/[\s\-\(\)\.]/g, "");
    // Check if it already starts with +
    if (!sanitizedNumber.startsWith("+")) {
      // If it starts with 00 (international prefix), replace with +
      if (sanitizedNumber.startsWith("00")) {
        sanitizedNumber = "+" + sanitizedNumber.slice(2);
      }
      // If it starts with a single 0, assume country code needed
      else if (sanitizedNumber.startsWith("0")) {
        return undefined;
      }
      // If no + and no special prefix, assume it's invalid
      else {
        return undefined;
      }
    }

    // E.164 format: + followed by 1-3 digit country code and 6-14 digit number
    // Total length including + should be 8-15 characters
    const e164Regex = /^\+[1-9]\d{6,14}$/;
    if (!e164Regex.test(sanitizedNumber)) {
      // Check specific issues
      if (sanitizedNumber.length < 8) { // Phone number too short (minimum 7 digits after country code)
        return undefined;
      } else if (sanitizedNumber.length > 15) { // Phone number too long (maximum 14 digits after country code)
        return undefined;
      } else if (sanitizedNumber[1] === "0") { // Country code cannot start with 0
        return undefined;
      } else { // Invalid E.164 format. Must be +[country code][phone number]
        return undefined
      }
    }
    const lookup = await this.twilioClient.lookups.v2.phoneNumbers(sanitizedNumber).fetch();
    if (!lookup.valid){
      return undefined;
    }
    return lookup.phoneNumber;
  }

  async maskTarget(target: string): Promise<string> {
    const countryCode = target.slice(0, 2);
    const numberPart = target.slice(2);
    if (numberPart.length <= 4) {
      return `${countryCode}${numberPart}`;
    }
    const visibleDigits = numberPart.slice(-4);
    const maskedPart = '*'.repeat(numberPart.length - 4);
    return `${countryCode}${maskedPart}${visibleDigits}`;
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
