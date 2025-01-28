export const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
export const e164Regex = /^\+?[1-9]\d{1,14}$/;