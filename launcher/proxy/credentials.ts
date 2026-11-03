import { join } from "node:path";
import type { CredentialSource } from "../config/index.ts";
import { type CommandRunner, expandHome, LauncherError, readJsonFile } from "../shared/index.ts";

export interface CredentialDeps {
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  home: string;
  platform?: NodeJS.Platform;
  providers?: string[];
  now?: () => number;
}

export interface Credentials {
  token(): Promise<string>;
}

type AuthEntry =
  | { type: "api_key"; key: string }
  | { type: "oauth"; access: string; refresh?: string; expires?: number };

type AuthFile = Record<string, AuthEntry>;

const SSO_DEFAULT_TTL_MS = 5 * 60 * 1000;

const SECONDS_THRESHOLD = 1e12;

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

const staticSource = (source: Extract<CredentialSource, { kind: "static" }>, deps: CredentialDeps) => {
  const cache: { token?: string } = {};

  const keychain = async (service: string) => {
    if ((deps.platform ?? process.platform) !== "darwin") {
      throw new LauncherError(
        `credentials.keychainService ${service} needs the macOS keychain`,
        "set credentials.envVar instead",
      );
    }

    const result = await deps.runner.run("security", ["find-generic-password", "-s", service, "-w"]);
    const token = result.stdout.trim();

    if (result.code !== 0 || token === "") {
      throw new LauncherError(
        `keychain item ${service} not readable: ${firstLine(result.stderr) || "empty"}`,
        `add it with: security add-generic-password -s ${service} -a "$USER" -w`,
      );
    }

    cache.token = token;

    return token;
  };

  const token = async () => {
    const fromEnv = source.envVar === undefined ? undefined : deps.env[source.envVar];

    if (fromEnv !== undefined && fromEnv !== "") {
      return fromEnv;
    }

    if (source.keychainService !== undefined) {
      return cache.token ?? keychain(source.keychainService);
    }

    throw new LauncherError(
      source.envVar === undefined
        ? "credentials.static needs envVar or keychainService"
        : `credentials.envVar ${source.envVar} is not set`,
      "set the variable in the shell that starts pi, or configure credentials.keychainService",
    );
  };

  return { token };
};

const entryToken = (provider: string, entry: AuthEntry, file: string, now: number) => {
  if (entry.type === "api_key" && typeof entry.key === "string" && entry.key !== "") {
    return entry.key;
  }

  if (entry.type !== "oauth" || typeof entry.access !== "string" || entry.access === "") {
    throw new LauncherError(`${file}: provider ${provider} has no usable key`, "log in with pi on the host");
  }

  if (typeof entry.expires === "number" && entry.expires <= now) {
    throw new LauncherError(
      `${file}: the OAuth token for ${provider} has expired`,
      "the sandbox does not refresh OAuth tokens; run pi on the host once to refresh it, then retry",
    );
  }

  return entry.access;
};

const pickProvider = (auth: AuthFile, providers: string[]) =>
  providers.find((provider) => auth[provider] !== undefined) ??
  Object.keys(auth).find((provider) => auth[provider]?.type === "api_key");

const hostPiAuthSource = (
  source: Extract<CredentialSource, { kind: "host-pi-auth" }>,
  deps: CredentialDeps,
) => {
  const file =
    source.authFile === undefined
      ? join(deps.home, ".pi", "agent", "auth.json")
      : expandHome(source.authFile, deps.home);

  const token = async () => {
    const auth = await readJsonFile<AuthFile>(file);

    if (auth === undefined || typeof auth !== "object" || auth === null) {
      throw new LauncherError(`${file}: not found`, "log in with pi on the host first");
    }

    const provider = pickProvider(auth, deps.providers ?? []);

    if (provider === undefined) {
      throw new LauncherError(`${file}: no provider with an API key`, "log in with pi on the host first");
    }

    return entryToken(provider, auth[provider] as AuthEntry, file, (deps.now ?? Date.now)());
  };

  return { token };
};

const expiryOf = (value: unknown) => {
  if (typeof value === "number") {
    return value < SECONDS_THRESHOLD ? value * 1000 : value;
  }

  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;

  return Number.isNaN(parsed) ? undefined : parsed;
};

const parseSsoOutput = (stdout: string) => {
  const text = stdout.trim();

  if (!text.startsWith("{")) {
    return { token: text, expiresAt: undefined };
  }

  try {
    const parsed = JSON.parse(text) as { token?: unknown; expiresAt?: unknown };

    return {
      token: typeof parsed.token === "string" ? parsed.token : "",
      expiresAt: expiryOf(parsed.expiresAt),
    };
  } catch {
    return { token: "", expiresAt: undefined };
  }
};

const ssoSource = (source: Extract<CredentialSource, { kind: "sso" }>, deps: CredentialDeps) => {
  const cache: { token?: string; expiresAt: number } = { expiresAt: 0 };
  const now = deps.now ?? Date.now;

  const fetchToken = async () => {
    const [file, ...args] = source.command;

    if (file === undefined || file === "") {
      throw new LauncherError("credentials.command is empty", "set credentials.command in the policy file");
    }

    const result = await deps.runner.run(file, args);
    const output = parseSsoOutput(result.stdout);

    if (result.code !== 0 || output.token === "") {
      throw new LauncherError(
        `credentials command ${file} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`,
        "run the command by hand to check the SSO session",
      );
    }

    cache.token = output.token;
    cache.expiresAt = output.expiresAt ?? now() + SSO_DEFAULT_TTL_MS;

    return output.token;
  };

  const token = async () =>
    cache.token !== undefined && now() < cache.expiresAt ? cache.token : fetchToken();

  return { token };
};

export const createCredentialSource = (source: CredentialSource, deps: CredentialDeps): Credentials => {
  if (source.kind === "static") {
    return staticSource(source, deps);
  }

  if (source.kind === "host-pi-auth") {
    return hostPiAuthSource(source, deps);
  }

  return ssoSource(source, deps);
};
