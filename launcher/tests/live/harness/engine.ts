import { existsSync } from "node:fs";
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
  Labels?: Record<string, string> | null;
}

export interface EngineNetwork {
  Id: string;
  Name: string;
  Containers?: Record<string, unknown>;
}

export const engineSocket = [join(homedir(), ".colima", "pi-sandbox", "docker.sock")].find((path) =>
  existsSync(path),
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

export const removeContainer = (id: string) => call("DELETE", `/containers/${id}?force=1&v=1`);

export const removeVolume = (name: string) => call("DELETE", `/volumes/${encodeURIComponent(name)}?force=1`);

export const removeNetwork = (id: string) => call("DELETE", `/networks/${id}`);
