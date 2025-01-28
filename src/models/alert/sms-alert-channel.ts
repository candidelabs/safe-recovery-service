import {AlertChannel} from "./alert-channel";

export class SMSAlertChannel extends AlertChannel {

  constructor(alertId: string) {
    super(alertId);
  }

  async sendMessage(target: string, header: string, body: string): Promise<boolean> {
    return false;
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}