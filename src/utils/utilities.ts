export const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
export const e164Regex = /^\+?[1-9]\d{1,14}$/;

const bigIntHandler = (key: string, value: any) => (typeof value === 'bigint' ? value.toString(16)._0x() : value);
export function JsonBigIntParser(object: Record<string, any> | Record<string, any>[]): Record<string, any> | Record<string, any>[]{
  if (Array.isArray(object)) {
    const jsonObjects: Record<string, any> | Record<string, any>[] = [];
    for (const _object of object) {
      jsonObjects.push(JsonBigIntParser(_object));
    }
    return jsonObjects;
  }else{
    return JSON.parse(JSON.stringify(object, bigIntHandler));
  }
}