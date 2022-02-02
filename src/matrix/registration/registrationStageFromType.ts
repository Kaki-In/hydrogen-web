/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import type {BaseRegistrationStage} from "./stages/BaseRegistrationStage";
import type {HomeServerApi} from "../net/HomeServerApi";
import type {RegistrationDetails} from "./types/type";
import {DummyAuth} from "./stages/DummyAuth";
import {TermsAuth} from "./stages/TermsAuth";

type ClassDerivedFromBaseRegistration = { new(hsApi: HomeServerApi, registrationData: RegistrationDetails, session: string, params?: Record<string, any>): BaseRegistrationStage } & typeof BaseRegistrationStage;

export function registrationStageFromType(type: string): ClassDerivedFromBaseRegistration | undefined{
    switch (type) {
        case "m.login.dummy":
            return DummyAuth;
        case "m.login.terms":
            return TermsAuth;
    }
}
