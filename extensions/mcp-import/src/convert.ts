import { isPlainObject } from "../../../core/manager/guards.ts";
import type { Source } from "./args.ts";

type RawServer = Record<string, unknown>;

export type PiServer = Record<string, unknown>;

type Conversion = { server: PiServer; notes: string[] } | { skip: string };

export type ConvertContext = { home: string; sep: string };

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const PI_TYPES = ["stdio", "http", "streamable-http"];

const LITERAL_FIELDS = ["command", "cwd", "url"];

const CLAUDE_KEYS = [
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "headersHelper",
  "timeout",
  "oauth",
];

const CURSOR_KEYS = ["type", "command", "args", "env", "cwd", "url", "headers", "envFile", "auth"];

const OAUTH_KEYS = ["clientId", "callbackPort", "authServerMetadataUrl", "scope"];

const DEFAULTED = /\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]*\}/g;

const CURSOR_ENV = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const WORKSPACE = /\$\{workspaceFolder(?:Basename)?\}/;

// biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's literal placeholder
const HOME = "${userHome}";

const VARIABLE = /\$\{[^}]*\}/;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");

export const validName = (name: string) => SERVER_NAME.test(name);

const AUTHORIZATION_FROM_JSON =
  'node -e \'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const h=JSON.parse(s);const k=Object.keys(h).find((k)=>k.toLowerCase()==="authorization");process.stdout.write(k?String(h[k]):"")})\'';

export const helperCommand = (helper: string) => `!(${helper}) | ${AUTHORIZATION_FROM_JSON}`;

const transportSkip = (type: unknown) => {
  if (type === "sse") {
    return "uses the legacy SSE transport, which pi does not support; use the server's streamable HTTP URL (often /mcp instead of /sse)";
  }

  if (type === "ws") {
    return "uses the WebSocket transport, which pi does not support";
  }

  return `has transport type ${JSON.stringify(type)}; pi supports only stdio, http and streamable-http`;
};

const pick = (raw: RawServer): PiServer | string => {
  const out: PiServer = {};

  if (raw.type !== undefined) {
    out.type = raw.type;
  }

  if (typeof raw.command === "string" && (raw.type === undefined || raw.type === "stdio")) {
    out.command = raw.command;

    if (raw.args !== undefined) {
      if (!isStringArray(raw.args)) {
        return "has args that are not a list of strings";
      }

      out.args = raw.args;
    }

    if (raw.env !== undefined) {
      if (!isStringRecord(raw.env)) {
        return "has env values that are not strings";
      }

      out.env = { ...raw.env };
    }

    if (typeof raw.cwd === "string") {
      out.cwd = raw.cwd;
    }

    return out;
  }

  if (typeof raw.url === "string" && raw.type !== "stdio") {
    out.url = raw.url;

    if (raw.headers !== undefined) {
      if (!isStringRecord(raw.headers)) {
        return "has header values that are not strings";
      }

      out.headers = { ...raw.headers };
    }

    return out;
  }

  return 'needs "command" (stdio) or "url" (streamable HTTP)';
};

const mapStrings = (server: PiServer, map: (field: string, value: string) => string) => {
  LITERAL_FIELDS.filter((field) => typeof server[field] === "string").forEach((field) => {
    server[field] = map(field, server[field] as string);
  });

  if (isStringArray(server.args)) {
    server.args = server.args.map((arg) => map("args", arg));
  }

  ["env", "headers"]
    .filter((field) => isStringRecord(server[field]))
    .forEach((field) => {
      const values = server[field] as Record<string, string>;

      server[field] = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, map(`${field}.${key}`, value)]),
      );
    });
};

const strings = (server: PiServer): [string, string][] => [
  ...LITERAL_FIELDS.filter((field) => typeof server[field] === "string").map((field): [string, string] => [
    field,
    server[field] as string,
  ]),
  ...(isStringArray(server.args) ? server.args.map((arg): [string, string] => ["args", arg]) : []),
  ...["env", "headers"].flatMap((field) =>
    isStringRecord(server[field])
      ? Object.entries(server[field] as Record<string, string>).map(([key, value]): [string, string] => [
          `${field}.${key}`,
          value,
        ])
      : [],
  ),
];

const escapeCommands = (server: PiServer, notes: string[]) => {
  mapStrings(server, (field, value) => {
    if (!/^(env|headers)\./.test(field) || !value.startsWith("!")) {
      return value;
    }

    notes.push(
      `${field} starts with "!", which pi would run as a command; written as "$!..." to keep it literal`,
    );
    return `$${value}`;
  });
};

const warnUnexpanded = (server: PiServer, notes: string[]) => {
  const fields = [
    ...new Set(
      strings(server)
        .filter(([field, value]) => !/^(env|headers)\./.test(field) && VARIABLE.test(value))
        .map(([field]) => field),
    ),
  ];

  if (fields.length > 0) {
    notes.push(
      `pi expands variables only in env and headers; ${fields.join(", ")} keep their \${...} text as written`,
    );
  }
};

const dropUnknown = (raw: RawServer, known: string[], notes: string[]) => {
  const unknownKeys = Object.keys(raw).filter((key) => !known.includes(key));

  if (unknownKeys.length > 0) {
    notes.push(`dropped ${unknownKeys.join(", ")}: pi has no such field`);
  }
};

const convertTimeout = (raw: RawServer, server: PiServer, notes: string[]) => {
  if (raw.timeout === undefined) {
    return;
  }

  if (typeof raw.timeout !== "number" || !(raw.timeout > 0)) {
    notes.push("dropped timeout: not a positive number of milliseconds");
    return;
  }

  server.timeout = Math.ceil(raw.timeout / 1000);
  notes.push(`timeout ${raw.timeout} ms became ${server.timeout} s`);
};

const convertOAuth = (raw: RawServer, server: PiServer, notes: string[]) => {
  if (raw.oauth === undefined) {
    return;
  }

  if (!isPlainObject(raw.oauth) || !("url" in server)) {
    notes.push("dropped oauth: not an object on an HTTP server");
    return;
  }

  const oauth = raw.oauth;
  const kept = Object.fromEntries(
    OAUTH_KEYS.filter((key) => oauth[key] !== undefined).map((key) => [key, oauth[key]]),
  );
  const dropped = Object.keys(oauth).filter((key) => !OAUTH_KEYS.includes(key));

  if (Object.keys(kept).length > 0) {
    server.oauth = kept;
  }

  if (dropped.length > 0) {
    notes.push(`dropped oauth ${dropped.join(", ")}: pi has no such field`);
  }
};

const convertHelper = (raw: RawServer, server: PiServer, notes: string[]) => {
  if (raw.headersHelper === undefined) {
    return;
  }

  if (typeof raw.headersHelper !== "string" || !("url" in server)) {
    notes.push("dropped headersHelper: not a command on an HTTP server");
    return;
  }

  server.headers = {
    ...(server.headers as Record<string, string> | undefined),
    Authorization: helperCommand(raw.headersHelper),
  };
  notes.push(
    "headersHelper became an Authorization header that runs it (!command); pi keeps the output for the whole session, and other headers it prints must be added by hand",
  );
};

const convertClaude = (raw: RawServer, notes: string[]): Conversion => {
  const picked = pick(raw);

  if (typeof picked === "string") {
    return { skip: picked };
  }

  mapStrings(picked, (field, value) =>
    value.replace(DEFAULTED, (whole, name) => {
      notes.push(`${field}: ${whole} became \${${name}}; pi has no defaults, so set ${name}`);
      return `\${${name}}`;
    }),
  );

  escapeCommands(picked, notes);
  convertHelper(raw, picked, notes);
  convertTimeout(raw, picked, notes);
  convertOAuth(raw, picked, notes);
  warnUnexpanded(picked, notes);
  dropUnknown(raw, CLAUDE_KEYS, notes);

  return { server: picked, notes };
};

const replaceHome = (field: string, value: string, home: string) => {
  const atStart = ["command", "cwd", "args"].includes(field) && /^\$\{userHome\}(?:[/\\]|$)/.test(value);
  const rest = atStart ? `~${value.slice(HOME.length)}` : value;

  return rest.split(HOME).join(home);
};

const convertCursor = (raw: RawServer, notes: string[], context: ConvertContext): Conversion => {
  const picked = pick(raw);

  if (typeof picked === "string") {
    return { skip: picked };
  }

  const workspace = strings(picked).find(([, value]) => WORKSPACE.test(value));

  if (workspace) {
    return {
      skip: `uses \${workspaceFolder} in ${workspace[0]}, which has no pi equivalent; add it by hand with a path (pi resolves a relative cwd against the session directory)`,
    };
  }

  mapStrings(picked, (field, value) => {
    const env = value.replace(CURSOR_ENV, (whole, name) => {
      notes.push(`${field}: ${whole} became \${${name}}`);
      return `\${${name}}`;
    });

    const home = env.includes(HOME) ? replaceHome(field, env, context.home) : env;

    if (home !== env) {
      notes.push(`${field}: \${userHome} became ${home.startsWith("~") ? "~" : "the home directory"}`);
    }

    return home.replace(/\$\{(?:pathSeparator|\/)\}/g, context.sep);
  });

  escapeCommands(picked, notes);

  if (raw.envFile !== undefined) {
    notes.push("dropped envFile: pi does not read env files; put the variables in env or in your shell");
  }

  if (raw.auth !== undefined) {
    notes.push("dropped auth (OAuth client settings): sign in with /mcp");
  }

  warnUnexpanded(picked, notes);
  dropUnknown(raw, CURSOR_KEYS, notes);

  return { server: picked, notes };
};

export const convertServer = (source: Source, raw: unknown, context: ConvertContext): Conversion => {
  if (!isPlainObject(raw)) {
    return { skip: "is not an object" };
  }

  if (raw.type !== undefined && !PI_TYPES.includes(raw.type as string)) {
    return { skip: transportSkip(raw.type) };
  }

  const notes: string[] = [];

  return source === "claude" ? convertClaude(raw, notes) : convertCursor(raw, notes, context);
};

export const needsSignIn = (server: PiServer) =>
  typeof server.url === "string" &&
  !Object.keys(isPlainObject(server.headers) ? server.headers : {}).some(
    (key) => key.toLowerCase() === "authorization",
  );
