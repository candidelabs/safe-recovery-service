import { AlertChannel } from "./alert-channel";
import twilio, { Twilio } from "twilio";

export class SMSAlertChannel extends AlertChannel {
  private twilioClient: Twilio;
  private readonly fromNumber: string;

  constructor(alertId: string, accountSid: string, authToken: string, fromNumber: string) {
    super(alertId);
    this.alertId = alertId;
    this.twilioClient = twilio(accountSid, authToken);
    this.fromNumber = fromNumber;
  }

  async sendMessage(target: string, header: string, body: string): Promise<boolean> {
    try {
      const message = await this.twilioClient.messages.create({
        body: `${header}\n${body}`,
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
