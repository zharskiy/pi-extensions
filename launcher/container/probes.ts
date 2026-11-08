import { get } from "node:http";
import { Readable, Writable } from "node:stream";
import type { Backend } from "../backend/index.ts";
import { isAuthLikeHeader, isPlaceholder, isSecretName } from "../shared/index.ts";

export interface CheckResult {
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
}

export interface ProbeTarget {
  backend: Backend;
  containerId: string;
  workdir: string;
}

interface Leaf {
  path: string;
  value: string;
}

const GUEST_AUTH_FILE = "/home/pi/.pi/agent/auth.json";

const GUEST_MCP_FILE = "/home/pi/.pi/agent/mcp.json";

const TOKEN_FIELDS = ["access", "refresh"];

const HEALTH_TIMEOUT_MS = 2000;

const ROUTE_TARGET = "1.1.1.1:443";

const NO_ROUTE_PROBE = [
  "sh",
  "-c",
  [
    "if command -v nc >/dev/null 2>&1; then exec nc -w 3 1.1.1.1 443 </dev/null; fi",
    "if command -v socat >/dev/null 2>&1; then exec socat -u OPEN:/dev/null TCP:1.1.1.1:443,connect-timeout=3; fi",
    "exit 127",
  ].join("; "),
];

const COMMAND_MISSING = 127;

export const passed = (detail: string): CheckResult => ({ status: "ok", detail });

export const warned = (detail: string): CheckResult => ({ status: "warn", detail });

export const failed = (detail: string): CheckResult => ({ status: "fail", detail });

export const skipped = (detail: string): CheckResult => ({ status: "skip", detail });

const collector = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      chunks.push(Buffer.from(chunk));

      done();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

const execCapture = async (target: ProbeTarget, command: string[]) => {
  const stdout = collector();
  const stderr = collector();
  const exitCode = await target.backend.exec(
    { containerId: target.containerId, command, env: {}, workdir: target.workdir },
    { stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream, tty: false },
  );

  return { exitCode, output: stdout.text() };
};

const stringLeaves = (value: unknown, path: string): Leaf[] => {
  if (typeof value === "string") {
    return [{ path, value }];
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    stringLeaves(child, path === "" ? key : `${path}.${key}`),
  );
};

const parsedJson = (output: string) => {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
};

const lastSegment = (path: string) => path.split(".").at(-1) ?? "";

const isPlaceholderValue = (value: string, placeholder: string | undefined) =>
  value === "" ||
  value === placeholder ||
  isPlaceholder(value) ||
  isPlaceholder(value.trim().split(/\s+/).at(-1) ?? "");

const isSecretField = (path: string) => {
  const name = lastSegment(path);

  return name !== "type" && (TOKEN_FIELDS.includes(name) || isSecretName(name));
};

const foreignAuthPaths = (auth: unknown, placeholder: string | undefined) =>
  stringLeaves(auth, "")
    .filter((leaf) => isSecretField(leaf.path) && !isPlaceholderValue(leaf.value, placeholder))
    .map((leaf) => leaf.path);

const isMcpSecret = (path: string) => {
  const parts = path.split(".");
  const section = parts.at(-2);
  const name = parts.at(-1) ?? "";

  return (section === "headers" && isAuthLikeHeader(name)) || (section === "env" && isSecretName(name));
};

const foreignMcpPaths = (mcp: unknown, placeholder: string | undefined) =>
  stringLeaves(mcp, "")
    .filter((leaf) => isMcpSecret(leaf.path) && !isPlaceholderValue(leaf.value, placeholder))
    .map((leaf) => leaf.path);

const secretEnvNames = (output: string, placeholder: string | undefined) =>
  output
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => ({ name: line.slice(0, line.indexOf("=")), value: line.slice(line.indexOf("=") + 1) }))
    .filter(({ name, value }) => isSecretName(name) && !isPlaceholderValue(value, placeholder))
    .map(({ name }) => name);

const readGuestJson = async (target: ProbeTarget, path: string) => {
  const file = await execCapture(target, ["cat", path]);

  return file.exitCode === 0 ? parsedJson(file.output) : {};
};

export const sweepCredentials = async (target: ProbeTarget, placeholder: string | undefined) => {
  const env = await execCapture(target, ["env"]);
  const auth = await readGuestJson(target, GUEST_AUTH_FILE);
  const mcp = await readGuestJson(target, GUEST_MCP_FILE);
  const problems = [
    ...(env.exitCode === 0 ? [] : [`env exited ${env.exitCode}`]),
    ...(auth === undefined ? [`${GUEST_AUTH_FILE} is not JSON`] : []),
    ...(mcp === undefined ? [`${GUEST_MCP_FILE} is not JSON`] : []),
    ...secretEnvNames(env.output, placeholder).map(
      (name) => `environment variable ${name} holds a value other than the placeholder`,
    ),
    ...foreignAuthPaths(auth, placeholder).map(
      (path) => `${GUEST_AUTH_FILE} holds a value other than the placeholder at ${path}`,
    ),
    ...foreignMcpPaths(mcp, placeholder).map(
      (path) => `${GUEST_MCP_FILE} holds a value other than a placeholder at ${path}`,
    ),
  ];

  return problems.length === 0
    ? passed("no credential in the environment, auth.json or mcp.json")
    : failed(problems.join("; "));
};

export const checkSamePath = async (target: ProbeTarget, repoRoot: string) => {
  const { exitCode } = await execCapture(target, ["test", "-d", repoRoot]);

  return exitCode === 0
    ? passed(`${repoRoot} is mounted at the same path`)
    : failed(`${repoRoot} is not visible inside`);
};

export const checkNoRoute = async (target: ProbeTarget) => {
  const { exitCode } = await execCapture(target, NO_ROUTE_PROBE);

  if (exitCode === COMMAND_MISSING) {
    return failed("neither nc nor socat is in the image");
  }

  return exitCode === 0
    ? failed(`${ROUTE_TARGET} is reachable directly`)
    : passed(`no direct route to ${ROUTE_TARGET}`);
};

const proxyAuthorization = (token: string) =>
  `Basic ${Buffer.from(`pi-sandbox:${token}`).toString("base64")}`;

export const answersHealth = (port: number, token: string) =>
  new Promise<boolean>((resolve) => {
    const request = get(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        timeout: HEALTH_TIMEOUT_MS,
        headers: { "proxy-authorization": proxyAuthorization(token) },
      },
      (response) => {
        response.resume();

        resolve(response.statusCode === 200);
      },
    );

    request.on("timeout", () => request.destroy());

    request.on("error", () => resolve(false));
  });
