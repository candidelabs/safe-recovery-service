import {AlertChannel} from "./alert-channel";

export class EmailAlertChannel extends AlertChannel {
  constructor() {
    super();
  }

  sendMessage(target: string, header: string, body: string): void {
  }

  healthCheck(): boolean {
    return false;
  }
}