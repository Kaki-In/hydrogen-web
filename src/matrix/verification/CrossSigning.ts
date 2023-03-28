/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {verifyEd25519Signature, SignatureVerification} from "../e2ee/common";
import {pkSign} from "./common";
import {SASVerification} from "./SAS/SASVerification";
import {ToDeviceChannel} from "./SAS/channel/Channel";
import {VerificationEventType} from "./SAS/channel/types";
import type {SecretStorage} from "../ssss/SecretStorage";
import type {Storage} from "../storage/idb/Storage";
import type {Platform} from "../../platform/web/Platform";
import type {DeviceTracker} from "../e2ee/DeviceTracker";
import type {HomeServerApi} from "../net/HomeServerApi";
import type {Account} from "../e2ee/Account";
import type {ILogItem} from "../../logging/types";
import type {DeviceMessageHandler} from "../DeviceMessageHandler.js";
import type {SignedValue, DeviceKey} from "../e2ee/common";
import type * as OlmNamespace from "@matrix-org/olm";
type Olm = typeof OlmNamespace;

// we store cross-signing (and device) keys in the format we get them from the server
// as that is what the signature is calculated on, so to verify and sign, we need
// it in this format anyway.
export type CrossSigningKey = SignedValue & {
    readonly user_id: string;
    readonly usage: ReadonlyArray<string>;
    readonly keys: {[keyId: string]: string};
}

export enum KeyUsage {
    Master = "master",
    SelfSigning = "self_signing",
    UserSigning = "user_signing"
};

export enum UserTrust {
    /** We trust the user, the whole signature chain checks out from our MSK to all of their device keys. */
    Trusted = 1,
    /** We haven't signed this user's identity yet. Verify this user first to sign it. */
    UserNotSigned,
    /** We have signed the user already, but the signature isn't valid.
    One possible cause could be that an attacker is uploading signatures in our name. */
    UserSignatureMismatch,
    /** We trust the user, but they don't trust one of their devices. */
    UserDeviceNotSigned,
    /** We trust the user, but the signatures of one of their devices is invalid.
     * One possible cause could be that an attacker is uploading signatures in their name. */
    UserDeviceSignatureMismatch,
    /** The user doesn't have a valid signature for the SSK with their MSK, or the SSK is missing.
     * This likely means bootstrapping cross-signing on their end didn't finish correctly. */
    UserSetupError,
    /** We don't have a valid signature for our SSK with our MSK, the SSK is missing, or we don't trust our own MSK.
     * This likely means bootstrapping cross-signing on our end didn't finish correctly. */
    OwnSetupError
}

enum MSKVerification {
    NoPrivKey,
    NoPubKey,
    DerivedPubKeyMismatch,
    Valid
}

export class CrossSigning {
    private readonly storage: Storage;
    private readonly secretStorage: SecretStorage;
    private readonly platform: Platform;
    private readonly deviceTracker: DeviceTracker;
    private readonly olm: Olm;
    private readonly olmUtil: Olm.Utility;
    private readonly hsApi: HomeServerApi;
    private readonly ownUserId: string;
    private readonly e2eeAccount: Account;
    private readonly deviceMessageHandler: DeviceMessageHandler;
    private _isMasterKeyTrusted: boolean = false;
    private readonly deviceId: string;
    private sasVerificationInProgress?: SASVerification;

    constructor(options: {
        storage: Storage,
        secretStorage: SecretStorage,
        deviceTracker: DeviceTracker,
        platform: Platform,
        olm: Olm,
        olmUtil: Olm.Utility,
        ownUserId: string,
        deviceId: string,
        hsApi: HomeServerApi,
        e2eeAccount: Account,
        deviceMessageHandler: DeviceMessageHandler,
    }) {
        this.storage = options.storage;
        this.secretStorage = options.secretStorage;
        this.platform = options.platform;
        this.deviceTracker = options.deviceTracker;
        this.olm = options.olm;
        this.olmUtil = options.olmUtil;
        this.hsApi = options.hsApi;
        this.ownUserId = options.ownUserId;
        this.deviceId = options.deviceId;
        this.e2eeAccount = options.e2eeAccount
        this.deviceMessageHandler = options.deviceMessageHandler;

        this.deviceMessageHandler.on("message", async ({ unencrypted: unencryptedEvent }) => {
            if (this.sasVerificationInProgress &&
                (
                    !this.sasVerificationInProgress.finished ||
                    // If the start message is for the previous sasverification, ignore it.
                    this.sasVerificationInProgress.channel.id === unencryptedEvent.content.transaction_id
                )) {
                return;
            }
            if (unencryptedEvent.type === VerificationEventType.Request ||
                unencryptedEvent.type === VerificationEventType.Start) {
                await this.platform.logger.run("Start verification from request", async (log) => {
                    const sas = this.startVerification(unencryptedEvent.sender, unencryptedEvent, log);
                    await sas?.start();
                });
            }
        })
    }

    /** @return {boolean} whether cross signing has been enabled on this account */
    async load(log: ILogItem): Promise<boolean> {
        // try to verify the msk without accessing the network
        const verification = await this.verifyMSKFrom4S(false, log);
        return verification !== MSKVerification.NoPrivKey;
    }

    async start(log: ILogItem): Promise<void> {
        if (!this.isMasterKeyTrusted) {
            // try to verify the msk _with_ access to the network
            await this.verifyMSKFrom4S(true, log);
        }
    }

    private async verifyMSKFrom4S(allowNetwork: boolean, log: ILogItem): Promise<MSKVerification> {
        return await log.wrap("CrossSigning.verifyMSKFrom4S", async log => {
            // TODO: use errorboundary here
            const privateMasterKey = await this.getSigningKey(KeyUsage.Master);
            if (!privateMasterKey) {
                log.set("failure", "no_priv_msk");
                return MSKVerification.NoPrivKey;
            }
            const signing = new this.olm.PkSigning();
            let derivedPublicKey;
            try {
                derivedPublicKey = signing.init_with_seed(privateMasterKey);    
            } finally {
                signing.free();
            }
            const publishedMasterKey = await this.deviceTracker.getCrossSigningKeyForUser(this.ownUserId, KeyUsage.Master, allowNetwork ? this.hsApi : undefined, log);
            if (!publishedMasterKey) {
                log.set("failure", "no_pub_msk");
                return MSKVerification.NoPubKey;
            }
            const publisedEd25519Key = publishedMasterKey && getKeyEd25519Key(publishedMasterKey);
            log.set({publishedMasterKey: publisedEd25519Key, derivedPublicKey});
            this._isMasterKeyTrusted = !!publisedEd25519Key && publisedEd25519Key === derivedPublicKey;
            if (!this._isMasterKeyTrusted) {
                log.set("failure", "mismatch");
                return MSKVerification.DerivedPubKeyMismatch;
            }
            return MSKVerification.Valid;
        });
    }

    get isMasterKeyTrusted(): boolean {
        return this._isMasterKeyTrusted;
    }

    startVerification(userId: string, startingMessage: any, log: ILogItem): SASVerification | undefined {
        if (this.sasVerificationInProgress && !this.sasVerificationInProgress.finished) {
            return;
        }
        const channel = new ToDeviceChannel({
            deviceTracker: this.deviceTracker,
            hsApi: this.hsApi,
            otherUserId: userId,
            clock: this.platform.clock,
            deviceMessageHandler: this.deviceMessageHandler,
            ourUserDeviceId: this.deviceId,
            log
        }, startingMessage);

        this.sasVerificationInProgress = new SASVerification({
            olm: this.olm,
            olmUtil: this.olmUtil,
            ourUserId: this.ownUserId,
            ourUserDeviceId: this.deviceId,
            otherUserId: userId,
            log,
            channel,
            e2eeAccount: this.e2eeAccount,
            deviceTracker: this.deviceTracker,
            hsApi: this.hsApi,
            clock: this.platform.clock,
        });
        return this.sasVerificationInProgress;
    }

    /** returns our own device key signed by our self-signing key. Other signatures will be missing. */
    async signOwnDevice(log: ILogItem): Promise<DeviceKey | undefined> {
        return log.wrap("CrossSigning.signOwnDevice", async log => {
            if (!this._isMasterKeyTrusted) {
                log.set("mskNotTrusted", true);
                return;
            }
            const ownDeviceKey = this.e2eeAccount.getUnsignedDeviceKey() as DeviceKey;
            return this.signDeviceKey(ownDeviceKey, log);
        });
    }

    /** @return the signed device key for the given device id */
    async signDevice(deviceId: string, log: ILogItem): Promise<DeviceKey | undefined> {
        return log.wrap("CrossSigning.signDevice", async log => {
            log.set("id", deviceId);
            if (!this._isMasterKeyTrusted) {
                log.set("mskNotTrusted", true);
                return;
            }
            const keyToSign = await this.deviceTracker.deviceForId(this.ownUserId, deviceId, this.hsApi, log);
            if (!keyToSign) {
                return undefined;
            }
            delete keyToSign.signatures;
            return this.signDeviceKey(keyToSign, log);
        });
    }

    /** @return the signed MSK for the given user id */
    async signUser(userId: string, log: ILogItem): Promise<CrossSigningKey | undefined> {
        return log.wrap("CrossSigning.signUser", async log => {
            log.set("id", userId);
            if (!this._isMasterKeyTrusted) {
                log.set("mskNotTrusted", true);
                return;
            }
            // can't sign own user
            if (userId === this.ownUserId) {
                return;
            }
            const keyToSign = await this.deviceTracker.getCrossSigningKeyForUser(userId, KeyUsage.Master, this.hsApi, log);
            if (!keyToSign) {
                return;
            }
            const signingKey = await this.getSigningKey(KeyUsage.UserSigning);
            if (!signingKey) {
                return;
            }
            delete keyToSign.signatures;
            // add signature to keyToSign
            this.signKey(keyToSign, signingKey);
            const payload = {
                [keyToSign.user_id]: {
                    [getKeyEd25519Key(keyToSign)!]: keyToSign
                }
            };
            const request = this.hsApi.uploadSignatures(payload, {log});
            await request.response();
            return keyToSign;
        });
    }

    async getUserTrust(userId: string, log: ILogItem): Promise<UserTrust> {
        return log.wrap("getUserTrust", async log => {
            log.set("id", userId);
            if (!this.isMasterKeyTrusted) {
                return UserTrust.OwnSetupError;
            }
            const ourMSK = await log.wrap("get our msk", log => this.deviceTracker.getCrossSigningKeyForUser(this.ownUserId, KeyUsage.Master, this.hsApi, log));
            if (!ourMSK) {
                return UserTrust.OwnSetupError;
            }
            const ourUSK = await log.wrap("get our usk", log => this.deviceTracker.getCrossSigningKeyForUser(this.ownUserId, KeyUsage.UserSigning, this.hsApi, log));
            if (!ourUSK) {
                return UserTrust.OwnSetupError;
            }
            const ourUSKVerification = log.wrap("verify our usk", log => this.hasValidSignatureFrom(ourUSK, ourMSK, log));
            if (ourUSKVerification !== SignatureVerification.Valid) {
                return UserTrust.OwnSetupError;
            }
            const theirMSK = await log.wrap("get their msk", log => this.deviceTracker.getCrossSigningKeyForUser(userId, KeyUsage.Master, this.hsApi, log));
            if (!theirMSK) {
                /* assume that when they don't have an MSK, they've never enabled cross-signing on their client
                (or it's not supported) rather than assuming a setup error on their side.
                Later on, for their SSK, we _do_ assume it's a setup error as it doesn't make sense to have an MSK without a SSK */
                return UserTrust.UserNotSigned;
            }
            const theirMSKVerification = log.wrap("verify their msk", log => this.hasValidSignatureFrom(theirMSK, ourUSK, log));
            if (theirMSKVerification !== SignatureVerification.Valid) {
                if (theirMSKVerification === SignatureVerification.NotSigned) {
                    return UserTrust.UserNotSigned;
                } else { /* SignatureVerification.Invalid */
                    return UserTrust.UserSignatureMismatch;
                }
            }
            const theirSSK = await log.wrap("get their ssk", log => this.deviceTracker.getCrossSigningKeyForUser(userId, KeyUsage.SelfSigning, this.hsApi, log));
            if (!theirSSK) {
                return UserTrust.UserSetupError;
            }
            const theirSSKVerification = log.wrap("verify their ssk", log => this.hasValidSignatureFrom(theirSSK, theirMSK, log));
            if (theirSSKVerification !== SignatureVerification.Valid) {
                return UserTrust.UserSetupError;
            }
            const theirDeviceKeys = await log.wrap("get their devices", log => this.deviceTracker.devicesForUsers([userId], this.hsApi, log));
            const lowestDeviceVerification = theirDeviceKeys.reduce((lowest, dk) => log.wrap({l: "verify device", id: dk.device_id}, log => {
                const verification = this.hasValidSignatureFrom(dk, theirSSK, log);
                    // first Invalid, then NotSigned, then Valid
                    if (lowest === SignatureVerification.Invalid || verification === SignatureVerification.Invalid) {
                        return SignatureVerification.Invalid;
                    } else if (lowest === SignatureVerification.NotSigned || verification === SignatureVerification.NotSigned) {
                        return SignatureVerification.NotSigned;
                    } else if (lowest === SignatureVerification.Valid || verification === SignatureVerification.Valid) {
                        return SignatureVerification.Valid;
                    }
                    // should never happen as we went over all the enum options
                    return SignatureVerification.Invalid;
            }), SignatureVerification.Valid);
            if (lowestDeviceVerification !== SignatureVerification.Valid) {
                if (lowestDeviceVerification === SignatureVerification.NotSigned) {
                    return UserTrust.UserDeviceNotSigned;
                } else { /* SignatureVerification.Invalid */
                    return UserTrust.UserDeviceSignatureMismatch;
                }
            }
            return UserTrust.Trusted;
        });
    }

    private async signDeviceKey(keyToSign: DeviceKey, log: ILogItem): Promise<DeviceKey | undefined> {
        const signingKey = await this.getSigningKey(KeyUsage.SelfSigning);
        if (!signingKey) {
            return undefined;
        }
        // add signature to keyToSign
        this.signKey(keyToSign, signingKey);
        // so the payload format of a signature is a map from userid to key id of the signed key
        // (without the algoritm prefix though according to example, e.g. just device id or base 64 public key)
        // to the complete signed key with the signature of the signing key in the signatures section.
        const payload = {
            [keyToSign.user_id]: {
                [keyToSign.device_id]: keyToSign
            }
        };
        const request = this.hsApi.uploadSignatures(payload, {log});
        await request.response();
        return keyToSign;
    }

    private async getSigningKey(usage: KeyUsage): Promise<Uint8Array | undefined> {
        const seedStr = await this.secretStorage.readSecret(`m.cross_signing.${usage}`);
        if (seedStr) {
            return new Uint8Array(this.platform.encoding.base64.decode(seedStr));
        }
    }

    private signKey(keyToSign: DeviceKey | CrossSigningKey, signingKey: Uint8Array) {
        pkSign(this.olm, keyToSign, signingKey, this.ownUserId, "");
    }

    private hasValidSignatureFrom(key: DeviceKey | CrossSigningKey, signingKey: CrossSigningKey, log: ILogItem): SignatureVerification {
        const pubKey = getKeyEd25519Key(signingKey);
        if (!pubKey) {
            return SignatureVerification.NotSigned;
        }
        return verifyEd25519Signature(this.olmUtil, signingKey.user_id, pubKey, pubKey, key, log);
    }
}

export function getKeyUsage(keyInfo: CrossSigningKey): KeyUsage | undefined {
    if (!Array.isArray(keyInfo.usage) || keyInfo.usage.length !== 1) {
        return undefined;
    }
    const usage = keyInfo.usage[0];
    if (usage !== KeyUsage.Master && usage !== KeyUsage.SelfSigning && usage !== KeyUsage.UserSigning) {
        return undefined;
    }
    return usage;
}

const algorithm = "ed25519";
const prefix = `${algorithm}:`;

export function getKeyEd25519Key(keyInfo: CrossSigningKey): string | undefined {
    const ed25519KeyIds = Object.keys(keyInfo.keys).filter(keyId => keyId.startsWith(prefix));
    if (ed25519KeyIds.length !== 1) {
        return undefined;
    }
    const keyId = ed25519KeyIds[0];
    const publicKey = keyInfo.keys[keyId];
    return publicKey;
}

export function getKeyUserId(keyInfo: CrossSigningKey): string | undefined {
    return keyInfo["user_id"];
}
