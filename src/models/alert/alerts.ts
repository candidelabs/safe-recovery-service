import {AlertChannel} from "./alert-channel";

export class Alerts {
  private alertConfig: Map<string, AlertChannel[]> = new Map();
  //
  private static _instance?: Alerts;

  private constructor() {
    //
  }

  public static instance(): Alerts {
    if (!Alerts._instance) {
      Alerts._instance = new Alerts();
    }
    return Alerts._instance;
  }

  public getAlertChannels(id: string){
    return this.alertConfig.get(id);
  }

  public addAlertChannel(id: string, alertChannel: AlertChannel){
    if (this.alertConfig.has(id)){
      this.alertConfig.get(id)!.push(alertChannel);
      return;
    }
    this.alertConfig.set(id, [alertChannel]);
  }
}