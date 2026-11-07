import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { type HttpsFixture, type SeenRequest, startHttpsFixture } from "./https-fixture.ts";
import type { TestCertificate } from "./test-ca.ts";

export interface GitFixture extends HttpsFixture {
  repoUrl(host: string): string;
  basic: string;
  publish(version: number): Promise<void>;
  authorizations(): string[];
}

const run = promisify(execFile);

const REPO = "org/fixture-extension.git";

export const extensionTool = (version: number) => `fixture_extension_v${version}`;

const extensionSource = (version: number) => `export default function (pi) {
  pi.registerTool({
    name: "${extensionTool(version)}",
    label: "Fixture extension v${version}",
    description: "Tool registered by the git-hosted fixture extension, version ${version}",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "fixture extension v${version}" }], details: {} };
    },
  });
}
`;

const manifest = (version: number) =>
  `${JSON.stringify(
    {
      name: "fixture-extension",
      version: `1.0.${version}`,
      type: "module",
      pi: { extensions: ["./index.js"] },
    },
    null,
    2,
  )}\n`;

const git = (cwd: string, args: string[]) =>
  run("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd });

const cgiEnv = (root: string, request: SeenRequest) => {
  const [pathInfo = "/", query = ""] = request.path.split("?");

  return {
    PATH: process.env.PATH ?? "",
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: request.method,
    PATH_INFO: pathInfo,
    QUERY_STRING: query,
    CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
    CONTENT_LENGTH: String(request.raw.length),
    HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"] ?? ""),
    GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
    REMOTE_USER: "fixture",
    REMOTE_ADDR: "127.0.0.1",
  };
};

const writeCgiOutput = (output: Buffer, response: ServerResponse) => {
  const split = output.indexOf("\r\n\r\n");
  const headerEnd = split === -1 ? output.indexOf("\n\n") : split;
  const separator = split === -1 ? 2 : 4;
  const lines = output.subarray(0, headerEnd).toString("utf8").split(/\r?\n/);
  const headers = Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  );
  const status = Number((headers.Status ?? "200").split(" ")[0]);

  delete headers.Status;

  response.writeHead(status, headers);

  response.end(output.subarray(headerEnd + separator));
};

const backend = (root: string, request: SeenRequest, response: ServerResponse) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env: cgiEnv(root, request) });
    const chunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.stderr.resume();

    child.once("error", reject);

    child.once("close", () => {
      writeCgiOutput(Buffer.concat(chunks), response);

      resolve();
    });

    child.stdin.end(request.raw);
  });

export const startGitFixture = async (
  certificate: TestCertificate,
  directory: string,
  credentials: { user: string; password: string },
): Promise<GitFixture> => {
  const root = join(directory, "git-root");
  const work = join(directory, "git-work");
  const basic = Buffer.from(`${credentials.user}:${credentials.password}`).toString("base64");

  await mkdir(join(root, "org"), { recursive: true });

  await mkdir(work, { recursive: true });

  await git(root, ["init", "--bare", "--initial-branch=main", REPO]);

  await git(work, ["init", "--initial-branch=main"]);

  await git(work, ["remote", "add", "origin", join(root, REPO)]);

  const publish = async (version: number) => {
    await writeFile(join(work, "package.json"), manifest(version));

    await writeFile(join(work, "index.js"), extensionSource(version));

    await git(work, ["add", "-A"]);

    await git(work, ["commit", "-m", `version ${version}`]);

    await git(work, ["push", "origin", "main"]);
  };

  const fixture = await startHttpsFixture(certificate, async (request, response) => {
    if (request.headers.authorization !== `Basic ${basic}`) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="fixture git"' });

      response.end();

      return;
    }

    await backend(root, request, response);
  });

  return {
    ...fixture,
    basic,
    publish,
    repoUrl: (host) => fixture.url(host, `/${REPO}`),
    authorizations: () => fixture.seen.map((request) => String(request.headers.authorization ?? "")),
  };
};
