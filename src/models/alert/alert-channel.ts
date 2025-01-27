export abstract class AlertChannel {

  protected constructor() {}

  /**
   * Sends a message to the target using the alert channel.
   * @param target The target email address or phone number.
   * @param header The message header or subject.
   * @param body The message body.
   */
  abstract sendMessage(target: string, header: string, body: string): Promise<boolean>;

  /**
   * Performs a health check to determine if the alert channel is available.
   */
  abstract healthCheck(): Promise<boolean>;
}
