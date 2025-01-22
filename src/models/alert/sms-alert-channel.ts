import {AlertChannel} from "./alert-channel";

export class SMSAlertChannel extends AlertChannel {
  constructor() {
    super();
  }

  sendMessage(target: string, header: string, body: string): void {
  }

  healthCheck(): boolean {
    return false;
  }
}