/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

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
import {Store} from "../Store";
import {IDOMStorage} from "../types";
import {SESSION_E2EE_KEY_PREFIX} from "../../../e2ee/common.js";
import {LogItem} from "../../../../logging/LogItem.js";
import {parse, stringify} from "../../../../utils/typedJSON";

export interface SessionEntry {
    key: string;
    value: any;
}

export class SessionStore {
    private _sessionStore: Store<SessionEntry>
    private _localStorage: IDOMStorage;

    constructor(sessionStore: Store<SessionEntry>, localStorage: IDOMStorage) {
        this._sessionStore = sessionStore;
        this._localStorage = localStorage;
    }

    async get(key: string): Promise<any> {
        const entry = await this._sessionStore.get(key);
        if (entry) {
            return entry.value;
        }
    }

    _writeKeyToLocalStorage(key: string, value: any) {
        // we backup to localStorage so when idb gets cleared for some reason, we don't lose our e2ee identity
        try {
            const lsKey = `${this._sessionStore.databaseName}.session.${key}`;
            const lsValue = stringify(value);
            this._localStorage.setItem(lsKey, lsValue);
        } catch (err) {
            console.error("could not write to localStorage", err);
        }
    }

    writeE2EEIdentityToLocalStorage() {
        this._sessionStore.iterateValues(undefined, (entry: SessionEntry, key: string) => {
            if (key.startsWith(SESSION_E2EE_KEY_PREFIX)) {
                this._writeKeyToLocalStorage(key, entry.value);
            }
            return false;
        });
    }

    async tryRestoreE2EEIdentityFromLocalStorage(log: LogItem): Promise<boolean> {
        let success = false;
        const lsPrefix = `${this._sessionStore.databaseName}.session.`;
        const prefix = `${lsPrefix}${SESSION_E2EE_KEY_PREFIX}`;
        for(let i = 0; i < this._localStorage.length; i += 1) {
            const lsKey = this._localStorage.key(i)!;
            if (lsKey.startsWith(prefix)) {
                const value = parse(this._localStorage.getItem(lsKey)!);
                const key = lsKey.substr(lsPrefix.length);
                // we check if we don't have this key already, as we don't want to override anything
                const hasKey = (await this._sessionStore.getKey(key)) === key;
                log.set(key, !hasKey);
                if (!hasKey) {
                    this._sessionStore.put({key, value});
                    success = true;
                }
            }
        }
        return success;
    }

    set(key: string, value: any): void {
        if (key.startsWith(SESSION_E2EE_KEY_PREFIX)) {
            this._writeKeyToLocalStorage(key, value);
        }
        this._sessionStore.put({key, value});
    }

    add(key: string, value: any): void {
        if (key.startsWith(SESSION_E2EE_KEY_PREFIX)) {
            this._writeKeyToLocalStorage(key, value);
        }
        this._sessionStore.add({key, value});
    }

    remove(key: string): void {
        if (key.startsWith(SESSION_E2EE_KEY_PREFIX)) {
            this._localStorage.removeItem(this._sessionStore.databaseName + key);
        }
        this._sessionStore.delete(key);
    }
}
