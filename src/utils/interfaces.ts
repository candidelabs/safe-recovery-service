export interface SummaryMessageData {
  header: string;
  critical?: string;
  accountChanges?: string[]
}

export interface SmtpConfig {
  from: string;
  //
  host: string;
  port: number;
  secure: boolean;
  auth: {
    type: 'oauth2' | 'login';
    user: string;
    pass?: string;
    accessToken?: string
  }
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface WebhookConfig {
  endpoint: string;
  authorizationHeader?: string;
}

