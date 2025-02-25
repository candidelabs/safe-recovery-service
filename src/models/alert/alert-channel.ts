import {MessageTemplates} from "./message-templates";

export abstract class AlertChannel {
  public alertId: string;
  public channelName: string;

  protected constructor(alertId: string, channelName: string) {
    this.alertId = alertId;
    this.channelName = channelName;
  }

  /**
   * Verifies and sanitizes a channel target.
   */
  abstract sanitizeTarget(target: string): Promise<string | undefined>;

  /**
   * Masks a channel target.
   */
  abstract maskTarget(target: string): Promise<string>;

  /**
   * Generates a challenge that can be later verified (outputs the raw challenge and a hashed version).
   */
  abstract generateChallenge(seed: string): Promise<[string, string]>;

  /**
   * Verifies a challenge to be correct when provided with the correct seed.
   */
  abstract verifyChallenge(challenge: string, hashedChallenge: string, seed: string): Promise<boolean>;

  /**
   * Sends a message to the target using the alert channel.
   * @param templateId The message template id.
   * @param target The target email address or phone number.
   * @param templateOverrides The template overrides.
   */
  abstract sendMessage(templateId: MessageTemplates, target: string, templateOverrides?: Record<string, string>): Promise<boolean>;

  /**
   * Performs a health check to determine if the alert channel is available.
   */
  abstract healthCheck(): Promise<boolean>;
}
