import {AlertChannel} from "./alert-channel";

export class SMSAlertChannel extends AlertChannel {
  constructor() {
    super();
  }

  async sendMessage(target: string, header: string, body: string): Promise<boolean> {
    return false;
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}