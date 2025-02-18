import {AlertChannel} from "./alert-channel";

export class Alerts {
  private alertConfig: Map<string, Map<string, AlertChannel>> = new Map();
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

  public alertIdExists(id: string){
    return this.alertConfig.has(id);
  }

  public getAlertChannel(id: string, channel: string){
    if (id === "") return;
    return this.alertConfig.get(id)?.get(channel);
  }

  public addAlertChannel(id: string, alertChannel: AlertChannel){
    if (!this.alertConfig.has(id)){
      this.alertConfig.set(id, new Map());
    }
    this.alertConfig.get(id)!.set(alertChannel.channelName, alertChannel);
  }
}