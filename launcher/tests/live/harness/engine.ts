import { existsSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EngineContainer {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

export interface EngineVolume {
  Name: string;
}

export interface EngineNetwork {
  Id: string;
  Name: string;
  Containers?: Record<string, unknown>;
}

const UNIX_PREFIX = "unix://";

const colimaSockets = () => {
  const root = join(homedir(), ".colima");

  return existsSync(root) ? readdirSync(root).map((profile) => join(root, profile, "docker.sock")) : [];
};

const dockerHost = process.env.DOCKER_HOST?.startsWith(UNIX_PREFIX)
  ? process.env.DOCKER_HOST.slice(UNIX_PREFIX.length)
  : undefined;

export const engineSocket = [dockerHost, ...colimaSockets(), "/var/run/docker.sock"].find(
  (path): path is string => path !== undefined && existsSync(path),
);

const call = <T>(method: string, path: string) =>
  new Promise<{ status: number; body: T | undefined }>((resolve, reject) => {
    const sent = request({ socketPath: engineSocket, method, path }, (response) => {
      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer) => chunks.push(chunk));

      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");

        resolve({
          status: response.statusCode ?? 0,
          body: text === "" ? undefined : (JSON.parse(text) as T),
        });
      });
    });

    sent.once("error", reject);

    sent.end();
  });

const filters = (value: Record<string, string[]>) => encodeURIComponent(JSON.stringify(value));

export const listContainers = async (labels: Record<string, string> = {}) => {
  const label = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  const query = label.length === 0 ? filters({ name: ["pi-sandbox"] }) : filters({ label });
  const response = await call<EngineContainer[]>("GET", `/containers/json?all=1&filters=${query}`);

  return response.body ?? [];
};

export const listVolumes = async () => {
  const response = await call<{ Volumes: EngineVolume[] | null }>(
    "GET",
    `/volumes?filters=${filters({ name: ["pi-sandbox"] })}`,
  );

  return response.body?.Volumes ?? [];
};

export const listNetworks = async () => {
  const response = await call<EngineNetwork[]>(
    "GET",
    `/networks?filters=${filters({ name: ["pi-sandbox"] })}`,
  );

  return response.body ?? [];
};

export const inspectNetwork = async (id: string) =>
  (await call<EngineNetwork>("GET", `/networks/${id}`)).body;

export const removeContainer = (id: string) => call("DELETE", `/containers/${id}?force=1&v=1`);

export const startContainer = (id: string) => call("POST", `/containers/${id}/start`);

export const removeVolume = (name: string) => call("DELETE", `/volumes/${encodeURIComponent(name)}?force=1`);

export const removeNetwork = (id: string) => call("DELETE", `/networks/${id}`);

export const engineListing = async () => {
  const [containers, volumes, networks] = await Promise.all([
    listContainers(),
    listVolumes(),
    listNetworks(),
  ]);

  return {
    containers: containers.map((container) => `${container.Names.join(",")} ${container.State}`),
    volumes: volumes.map((volume) => volume.Name),
    networks: networks.map((network) => network.Name),
  };
};
