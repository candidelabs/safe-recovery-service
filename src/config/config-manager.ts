import Joi from "joi";
import {ethereumAddress, ethereumPrivateKey} from "../validations/custom.validation";
import {PrivateKeySigner} from "../models/signer/private-key-signer";
import {Signers} from "../models/signer/signers";
import {Alerts} from "../models/alert/alerts";
import {EmailAlertChannel} from "../models/alert/email-alert-channel";
import {SMSAlertChannel} from "../models/alert/sms-alert-channel";
import {Network} from "../models/network";
import {ethers} from "ethers";
import {KMSSigner} from "../models/signer/kms-signer";
import {e164Regex, periodToSeconds} from "../utils";
import {SmtpConfig, TwilioConfig, WebhookConfig} from "../utils/interfaces";
import isURL from "validator/lib/isURL";

type Config = {
  options: {
    env: string;
    port: number | string;
    indexerAlert: string;
    sentryDSN?: string;
    trustProxy: boolean | string;
    rateLimit: number | string;
  };
  signers: Array<{
    id: string;
    privateKey?: string;
    awsKMS?: {
      accessKeyId: string;
      secretAccessKeyId: string;
      region: string;
      kmsKeyId: string;
    };
  }>;
  alerts: Array<{
    id: string;
    channels: {
      email?: {
        smtp?: SmtpConfig;
        webhook?: WebhookConfig;
      };
      sms?: {
        twilio?: TwilioConfig
        webhook?: WebhookConfig;
      };
    };
  }>;
  networks: {
    [network: string]: {
      enabled: boolean;
      chainId: string | number;
      jsonRpcEndpoint: string;
      recoveryModuleAddress: string;
      executeRecoveryRequests?: {
        enabled: boolean;
        signer?: string;
        rateLimit?: {maxPerAccount: string | number, period: string} | '~';
      } | '~';
      finalizeRecoveryRequests?: {
        enabled: boolean;
        signer?: string;
        rateLimit?: {maxPerAccount: string | number, period: string} | '~';
      } | string;
      guardian?: string | '~';
      alerts?: string | '~';
      indexer: {
        enabled: boolean,
        startBlock: number
      };
      otpAlertBypassToken?: string;
    };
  };
};

export class Configuration {
  public environment!: string;
  public port!: number;
  public sentryDSN?: string;
  public indexerAlert!: string;
  public trustProxy!: boolean;
  public rateLimit!: number;
  private readonly config: Config;
  private static _instance?: Configuration;

  private constructor(config: Config) {
    this.config = this.resolveEnvVariables(config);
  }

  public static instance(config?: Config): Configuration {
    if (!Configuration._instance) {
      if (!config) {
        throw new Error("Configuration not initialized. Provide config on first use.");
      }
      Configuration._instance = new Configuration(config);
      Configuration._instance.initializeConfig();
    }
    return Configuration._instance;
  }

  private resolveEnvVariables(config: Config): Config {
    const resolveValue = (value: unknown): unknown => {
      if (typeof value === "string" && value.startsWith("ENV::")) {
        const envVar = value.replace("ENV::", "");
        const resolved = process.env[envVar];
        if (!resolved) {
          throw new Error(`Environment variable '${envVar}' is not set.`);
        }
        return resolved;
      }
      return value;
    };

    const deepResolve = (obj: any): any => {
      if (typeof obj === "object" && obj !== null) {
        for (const key in obj) {
          obj[key] = deepResolve(obj[key]);
        }
      } else {
        return resolveValue(obj);
      }
      return obj;
    };

    return deepResolve({ ...config });
  }

  private initializeConfig() {
    this.initializeOptions(this.config.options);
    this.initializeSigners(this.config.signers);
    this.initializeAlerts(this.config.alerts);
    this.initializeNetworks(this.config.networks);
  }

  private initializeOptions(options: Config["options"]) {
    if (!options.env || !options.port || !options.indexerAlert) {
      throw new Error("Options configuration is invalid. 'env', 'port' and 'indexerAlert' are required.");
    }
    options.env = options.env.toLowerCase();
    if (options.env !== "development" && options.env !== "production") {
      throw new Error("Options.env must be either 'development' or 'production'");
    }
    const port = Number(options.port);
    if (isNaN(port) || port <= 0) {
      throw new Error("Options.port must be a valid positive number.");
    }
    
    const rateLimit = Number(options.rateLimit);
    if (isNaN(rateLimit) || rateLimit <= 0) {
      throw new Error("Options.rateLimit must be a valid positive number.");
    }

    if (options.sentryDSN){
      this.sentryDSN = options.sentryDSN;
    }
    this.environment = options.env;
    this.port = port;
    this.indexerAlert = options.indexerAlert;
    this.trustProxy = (options.trustProxy ?? "true").toString().toLowerCase() === "true";
    this.rateLimit = rateLimit;
  }

  private initializeSigners(signers: Config["signers"]) {
    if (!signers || signers.length === 0) {
      throw new Error("At least one signer must be provided.");
    }

    signers.forEach((signer, index) => {
      if (!signer.id) {
        throw new Error(`Signer at index ${index} must have an 'id'.`);
      }
      if (!signer.privateKey && !signer.awsKMS) {
        throw new Error(`Signer '${signer.id}' must have either 'privateKey' or 'awsKMS' defined.`);
      }

      if (signer.privateKey && signer.awsKMS) {
        throw new Error(`Signer '${signer.id}' cannot have both 'privateKey' and 'awsKMS' defined.`);
      }

      if (signer.privateKey){
        const privateKeyValidation = Joi.required().custom(ethereumPrivateKey).validate(signer.privateKey);
        if (privateKeyValidation.error){
          throw new Error(`Signer '${signer.id}' has an invalid 'privateKey': ${privateKeyValidation.error.message}`);
        }
        const signerObject = new PrivateKeySigner(signer.id, signer.privateKey);
        Signers.instance().addSigner(signerObject);
      }

      if (signer.awsKMS){
        if (!signer.awsKMS.accessKeyId || !signer.awsKMS.secretAccessKeyId || !signer.awsKMS.region || !signer.awsKMS.kmsKeyId) {
          throw new Error(`Signer '${signer.id}' must have all fields 'accessKeyId', 'secretAccessKeyId', 'region', and 'kmsKeyId' defined.`);
        }
        const signerObject = new KMSSigner(
          signer.id,
          signer.awsKMS.accessKeyId,
          signer.awsKMS.secretAccessKeyId,
          signer.awsKMS.region,
          signer.awsKMS.kmsKeyId
        );
        Signers.instance().addSigner(signerObject);
      }

    });
  }

  private initializeAlerts(alerts: Config["alerts"]) {
    alerts.forEach((alert, index) => {
      if (!alert.id) {
        throw new Error(`Alert at index ${index} must have an 'id'.`);
      }
      const channels = alert.channels;
      if (!channels.email && !channels.sms) {
        throw new Error(`Alert '${alert.id}' must have at least one channel defined (email or sms).`);
      }

      if (channels.email) {
        if (!channels.email.smtp && !channels.email.webhook) {
          throw new Error(
            `Email channel for alert '${alert.id}' must have either 'smtp' or 'webhook'.`
          );
        }
        if (channels.email.smtp && channels.email.webhook) {
          throw new Error(
            `Email channel for alert '${alert.id}' cannot have both 'smtp' and 'webhook' defined.`
          );
        }
        let emailAlertChannel: EmailAlertChannel;
        if (channels.email.smtp){
          const smtpPort = Number(channels.email.smtp.port);
          if (isNaN(smtpPort) || smtpPort <= 0) {
            throw new Error(`Email channel for alert '${alert.id}' must have 'smtp.port' as a valid positive number.`);
          }
          if (
            !channels.email.smtp.from
            || !channels.email.smtp.host
            || !channels.email.smtp.auth
            || !channels.email.smtp.auth.type
            || !channels.email.smtp.auth.user
          ) {
            throw new Error(`Email channel for alert '${alert.id}' must have all fields 'smtp.from', 'smtp.host', 'smtp.auth', 'smtp.auth.type', and 'smtp.auth.user' defined.`);
          }
          if (channels.email.smtp.auth.type.toLowerCase() != 'oauth2' && channels.email.smtp.auth.type.toLowerCase() != 'login'){
            throw new Error(`Email channel for alert '${alert.id}' must have 'smtp.auth.type' as either 'oauth2' or 'login'`);
          }
          if (channels.email.smtp.auth.type.toLowerCase() == 'oauth2' && !channels.email.smtp.auth.accessToken){
            throw new Error(`Email channel for alert '${alert.id}' must have 'smtp.auth.accessToken' because type is defined as 'oauth2'`);
          }
          if (channels.email.smtp.auth.type.toLowerCase() == 'login' && !channels.email.smtp.auth.pass){
            throw new Error(`Email channel for alert '${alert.id}' must have 'smtp.auth.pass' because type is defined as 'login'`);
          }
          emailAlertChannel = new EmailAlertChannel(alert.id, channels.email.smtp, undefined);
        }
        if (channels.email.webhook){
          if (!channels.email.webhook.endpoint){
            throw new Error(`Email channel for alert '${alert.id}' webhook config must have 'webhook.endpoint' defined.`);
          }
          if (!isURL(channels.email.webhook.endpoint)){
            throw new Error(`Email channel for alert '${alert.id}' invalid url for 'webhook.endpoint' defined.`);
          }
          emailAlertChannel = new EmailAlertChannel(alert.id, undefined, channels.email.webhook);
        }
        Alerts.instance().addAlertChannel(alert.id, emailAlertChannel!);
      }

      if (channels.sms) {
        if (!channels.sms.twilio && !channels.sms.webhook) {
          throw new Error(
            `SMS channel for alert '${alert.id}' must have either 'twilio' or 'webhook'.`
          );
        }
        if (channels.sms.twilio && channels.sms.webhook) {
          throw new Error(
            `SMS channel for alert '${alert.id}' cannot have both 'twilio' and 'webhook'.`
          );
        }
        let smsAlertChannel: SMSAlertChannel;
        if (channels.sms.twilio){
          if (
            !channels.sms.twilio.accountSid
            || !channels.sms.twilio.authToken
            || !channels.sms.twilio.fromNumber
          ) {
            throw new Error(`SMS channel for alert '${alert.id}' twilio config must have all fields 'twilio.accountSid', 'twilio.authToken', and 'twilio.fromNumber' defined.`);
          }
          if (!e164Regex.test(channels.sms.twilio.fromNumber)){
            throw new Error(`SMS channel for alert '${alert.id}' twilio config must have a valid 'twilio.fromNumber' value that follows E.164 format (https://www.twilio.com/docs/glossary/what-e164).`);
          }
          smsAlertChannel = new SMSAlertChannel(alert.id, channels.sms.twilio, undefined);
        }
        if (channels.sms.webhook){
          if (!channels.sms.webhook.endpoint){
            throw new Error(`SMS channel for alert '${alert.id}' webhook config must have 'webhook.endpoint' defined.`);
          }
          if (!isURL(channels.sms.webhook.endpoint)){
            throw new Error(`SMS channel for alert '${alert.id}' invalid url for 'webhook.endpoint' defined.`);
          }
          smsAlertChannel = new SMSAlertChannel(alert.id, undefined, channels.sms.webhook);
        }
        Alerts.instance().addAlertChannel(alert.id, smsAlertChannel!);
      }
    });
    if (!Alerts.instance().alertIdExists(this.indexerAlert)){
      throw new Error(`options.indexerAlert '${this.indexerAlert}' is not found in declared alerts.`);
    }
  }

  private initializeNetworks(networks: Config["networks"]) {
    if (!networks || Object.keys(networks).length === 0) {
      throw new Error("At least one network configuration must be provided.");
    }
    Object.entries(networks).forEach(([networkName, networkConfig]) => {
      if (!networkConfig.enabled) return; // Skip disabled networks
      const chainId = Number(networkConfig.chainId);
      if (isNaN(chainId)) {
        throw new Error(`Network '${networkName}' 'chainId' must be a valid number.`);
      }
      if (!networkConfig.jsonRpcEndpoint) {
        throw new Error(`Network '${networkName}' must have a 'jsonRpcEndpoint'.`);
      }
      if (!networkConfig.recoveryModuleAddress) {
        throw new Error(`Network '${networkName}' must have a 'recoveryModuleAddress'.`);
      }
      if (Joi.required().custom(ethereumAddress).validate(networkConfig.recoveryModuleAddress).error) {
        throw new Error(`Network '${networkName}' must have a valid ethereum address for 'recoveryModuleAddress'.`);
      }
      //
      if (typeof networkConfig.executeRecoveryRequests == "string" && networkConfig.executeRecoveryRequests !== "~") throw new Error(`Network '${networkName}' cannot have 'executeRecoveryRequests' field as a string.`);
      if (!networkConfig.executeRecoveryRequests || typeof networkConfig.executeRecoveryRequests == "string"){
        networkConfig.executeRecoveryRequests = {enabled: false};
      }
      if (networkConfig.executeRecoveryRequests.enabled && !networkConfig.executeRecoveryRequests.signer) {
        throw new Error(
          `Network '${networkName}' executeRecoveryRequests requires a 'signer' when enabled.`
        );
      }
      if (networkConfig.executeRecoveryRequests.enabled) {
        if (!Signers.instance().getSigner(networkConfig.executeRecoveryRequests.signer!)){
          throw new Error(
            `Network '${networkName}' executeRecoveryRequests.signer is not found in declared signers.`
          );
        }
      }
      //
      let executionSponsorshipRateLimiting: {maxPerAccount: number, period: number} | undefined = undefined;
      if (typeof networkConfig.executeRecoveryRequests.rateLimit == "string" && networkConfig.executeRecoveryRequests.rateLimit !== "~") throw new Error(`Network '${networkName}' cannot have 'executeRecoveryRequests.rateLimit' field as a string.`);
      if (!networkConfig.executeRecoveryRequests.rateLimit || typeof networkConfig.executeRecoveryRequests.rateLimit == "string"){
        executionSponsorshipRateLimiting = undefined;
      }else{
        const maxPerAccount = Number(networkConfig.executeRecoveryRequests.rateLimit.maxPerAccount);
        if (isNaN(maxPerAccount) || maxPerAccount <= 0) {
          throw new Error("executeRecoveryRequests.rateLimit.maxPerAccount must be a valid positive number.");
        }
        executionSponsorshipRateLimiting = {
          maxPerAccount: Number(networkConfig.executeRecoveryRequests.rateLimit.maxPerAccount),
          period: periodToSeconds(networkConfig.executeRecoveryRequests.rateLimit.period),
        }
      }
      //
      if (typeof networkConfig.finalizeRecoveryRequests == "string" && networkConfig.finalizeRecoveryRequests !== "~") throw new Error(`Network '${networkName}' cannot have 'finalizeRecoveryRequests' field as a string.`);
      if (!networkConfig.finalizeRecoveryRequests || typeof networkConfig.finalizeRecoveryRequests == "string"){
        networkConfig.finalizeRecoveryRequests = {enabled: false};
      }
      if (networkConfig.finalizeRecoveryRequests.enabled && !networkConfig.finalizeRecoveryRequests.signer) {
        throw new Error(
          `Network '${networkName}' finalizeRecoveryRequests requires a 'signer' when enabled.`
        );
      }
      if (networkConfig.finalizeRecoveryRequests.enabled) {
        if (!Signers.instance().getSigner(networkConfig.finalizeRecoveryRequests.signer!)){
          throw new Error(
            `Network '${networkName}' finalizeRecoveryRequests.signer is not found in declared signers.`
          );
        }
      }
      let finalizationSponsorshipRateLimiting: {maxPerAccount: number, period: number} | undefined = undefined;
      if (typeof networkConfig.finalizeRecoveryRequests.rateLimit == "string" && networkConfig.finalizeRecoveryRequests.rateLimit !== "~") throw new Error(`Network '${networkName}' cannot have 'finalizeRecoveryRequests.rateLimit' field as a string.`);
      if (!networkConfig.finalizeRecoveryRequests.rateLimit || typeof networkConfig.finalizeRecoveryRequests.rateLimit == "string"){
        finalizationSponsorshipRateLimiting = undefined;
      }else{
        const maxPerAccount = Number(networkConfig.finalizeRecoveryRequests.rateLimit.maxPerAccount);
        if (isNaN(maxPerAccount) || maxPerAccount <= 0) {
          throw new Error("finalizeRecoveryRequests.rateLimit.maxPerAccount must be a valid positive number.");
        }
        finalizationSponsorshipRateLimiting = {
          maxPerAccount: Number(networkConfig.finalizeRecoveryRequests.rateLimit.maxPerAccount),
          period: periodToSeconds(networkConfig.finalizeRecoveryRequests.rateLimit.period),
        }
      }
      //
      if (networkConfig.guardian && networkConfig.guardian != "~") {
        if (!Signers.instance().getSigner(networkConfig.guardian)){
          throw new Error(
            `Specified guardian for network '${networkName}' is not found in declared signers.`
          );
        }
      }
      //
      if (networkConfig.alerts && networkConfig.alerts != "~") {
        if (!Alerts.instance().alertIdExists(networkConfig.alerts)){
          throw new Error(
            `Alerts for network '${networkName}' is not found in declared alerts.`
          );
        }
      }
      //
      if (!networkConfig.indexer) {
        throw new Error(`Network '${networkName}' must have an 'indexer' configuration object.`);
      }
      if (networkConfig.indexer.enabled === undefined) {
        throw new Error(`Network '${networkName}' 'indexer.enabled' must be a valid boolean value.`);
      }
      networkConfig.indexer.enabled = networkConfig.indexer.enabled.toString().toLowerCase() === "true";
      const indexerStartBlock = Number(networkConfig.indexer.startBlock);
      if (isNaN(indexerStartBlock)) {
        throw new Error(`Network '${networkName}' 'indexer.startBlock' must be a valid number.`);
      }
      networkConfig.indexer.startBlock = indexerStartBlock;
      new Network(
        networkName,
        chainId,
        networkConfig.recoveryModuleAddress,
        networkConfig.jsonRpcEndpoint,
        new ethers.providers.JsonRpcProvider(networkConfig.jsonRpcEndpoint),
        {...networkConfig.executeRecoveryRequests, rateLimit: executionSponsorshipRateLimiting},
        {...networkConfig.finalizeRecoveryRequests, rateLimit: finalizationSponsorshipRateLimiting},
        networkConfig.guardian == "~" ? undefined : networkConfig.guardian,
        networkConfig.alerts == "~" ? undefined : networkConfig.alerts,
        networkConfig.indexer,
        networkConfig.otpAlertBypassToken
      );
    });
    if (Network.instances.instances.length === 0) {
      throw new Error("At least one enabled network configuration must be provided.");
    }
  }
}
