/*
Copyright 2022 The Matrix.org Foundation C.I.C.

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

/// <reference types="cypress" />

import * as path from "path";
import * as os from "os";
import * as fse from "fs-extra";

import PluginEvents = Cypress.PluginEvents;
import PluginConfigOptions = Cypress.PluginConfigOptions;
import {dockerRun, dockerStop } from "../docker";

// A cypress plugins to add command to start & stop dex instances

interface DexConfig {
    configDir: string;
    baseUrl: string;
    port: number;
    host: string;
}

export interface DexInstance extends DexConfig {
    dexId: string;
}

const dexConfigs = new Map<string, DexInstance>();
let env;

async function produceConfigWithSynapseURLAdded(): Promise<DexConfig> {
    const templateDir = path.join(__dirname, "template");

    const stats = await fse.stat(templateDir);
    if (!stats?.isDirectory) {
        throw new Error(`Template directory at ${templateDir} not found!`);
    }
    const tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'hydrogen-testing-dex-'));

    // copy the contents of the template dir, omitting config.yaml as we'll template that
    console.log(`Copy ${templateDir} -> ${tempDir}`);
    await fse.copy(templateDir, tempDir, { filter: f => path.basename(f) !== 'config.yaml' });

    // now copy config.yaml, applying substitutions
    console.log(`Gen ${path.join(templateDir, "config.yaml")}`);
    let hsYaml = await fse.readFile(path.join(templateDir, "config.yaml"), "utf8");
    const synapseAddress = `${env.SYNAPSE_IP_ADDRESS}:${env.SYNAPSE_PORT}`;
    hsYaml = hsYaml.replace(/{{SYNAPSE_ADDRESS}}/g, synapseAddress);
    const host = env.DEX_IP_ADDRESS;
    const port = env.DEX_PORT;
    const dexAddress = `${host}:${port}`;
    hsYaml = hsYaml.replace(/{{DEX_ADDRESS}}/g, dexAddress);
    await fse.writeFile(path.join(tempDir, "config.yaml"), hsYaml);

    const baseUrl = `http://${host}:${port}`;
    return {
        host,
        port,
        baseUrl,
        configDir: tempDir,
    };
}

async function dexStart(): Promise<DexInstance> {
    const dexCfg = await produceConfigWithSynapseURLAdded();
    console.log(`Starting dex with config dir ${dexCfg.configDir}...`);
    const dexId = await dockerRun({
        image: "bitnami/dex:latest",
        containerName: "dex",
        dockerParams: [
            "--rm",
            "-v", `${dexCfg.configDir}:/data`,
            `--ip=${dexCfg.host}`,
            "-p", `${dexCfg.port}:5556/tcp`,
            "--network=hydrogen"
        ],
        applicationParams: [
            "serve",
            "data/config.yaml",
        ]
    });

    console.log(`Started dex with id ${dexId} on port ${dexCfg.port}.`);

    const dex: DexInstance = { dexId, ...dexCfg };
    dexConfigs.set(dexId, dex);
    return dex;
}

async function dexStop(id: string): Promise<void> {
    const dexCfg = dexConfigs.get(id);
    if (!dexCfg) throw new Error("Unknown dex ID");
    await dockerStop({ containerId: id, });
    await fse.remove(dexCfg.configDir);
    dexConfigs.delete(id);
    console.log(`Stopped dex id ${id}.`);
    // cypress deliberately fails if you return 'undefined', so
    // return null to signal all is well, and we've handled the task.
    return null;
}

/**
 * @type {Cypress.PluginConfig}
 */
export function dexDocker(on: PluginEvents, config: PluginConfigOptions) {
    env = config.env;

    on("task", {
        dexStart,
        dexStop,
    });

    on("after:spec", async (spec) => {
        for (const dexId of dexConfigs.keys()) {
            console.warn(`Cleaning up dex ID ${dexId} after ${spec.name}`);
            await dexStop(dexId);
        }
    });
}

