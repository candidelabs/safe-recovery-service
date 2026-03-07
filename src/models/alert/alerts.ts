import {AlertChannel} from "./alert-channel";

export class Alerts {
  private alertConfig: Map<string, Map<string, AlertChannel>> = new Map();
  private skipFirstSetupAlert: Map<string, boolean> = new Map();
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

  public getAlertChannels(id: string){
    if (id === "") return;
    if (!this.alertConfig.has(id)) return undefined;
    return Array.from(this.alertConfig.get(id)!.values());
  }

  public setSkipFirstAccountSetupAlert(id: string, value: boolean){
    this.skipFirstSetupAlert.set(id, value);
  }

  public getSkipFirstAccountSetupAlert(id: string): boolean {
    return this.skipFirstSetupAlert.get(id) ?? false;
  }

  public addAlertChannel(id: string, alertChannel: AlertChannel){
    if (!this.alertConfig.has(id)){
      this.alertConfig.set(id, new Map());
    }
    this.alertConfig.get(id)!.set(alertChannel.channelName, alertChannel);
  }
}