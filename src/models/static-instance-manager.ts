import Sugar from 'sugar'

type IdentifierObjectClass = {id: () => string};
export class StaticInstanceManager<T extends IdentifierObjectClass> {
  private instancesSet = new Set<string>();
  public instances: T[] = [];
  public initializer: ((arg0: T) => void) | undefined;

  constructor(initializer: ((arg0: T) => void) | undefined) {
    this.initializer = initializer;
  }

  public add(instance: T, forceReplace = false): void {
    const instanceId: string = instance.id();
    if (this.instancesSet.has(instanceId)) {
      if (!forceReplace) return;
      this.instances = Sugar.Array.remove(this.instances, (e) => e.id() === instanceId);
      this.instancesSet.delete(instanceId);
    }
    this.instances.push(instance);
    this.instancesSet.add(instanceId);
  }

  public remove(instance: T): void {
    const instanceId: string = instance.id();
    if (!this.instancesSet.has(instanceId)) return;
    this.instances = Sugar.Array.remove(this.instances, (e) => e.id() === instanceId);
    this.instancesSet.delete(instanceId);
  }

  public removeMany(instances: T[]): void {
    for (const instance of instances){
      const instanceId: string = instance.id();
      if (!this.instancesSet.has(instanceId)) continue;
      this.instances = Sugar.Array.remove(this.instances, (e) => e.id() === instanceId);
      this.instancesSet.delete(instanceId);
    }
  }

  public clear(){
    this.instances = [];
    this.instancesSet.clear();
  }

  public get(id: string): T | undefined {
    if (!this.instancesSet.has(id)) return undefined;
    return Sugar.Array.find(this.instances, (e) => e.id() === id);
  }

  public initialize(): void {
    if (!this.initializer) return;
    for (const instance of this.instances){
      this.initializer(instance);
    }
  }

}