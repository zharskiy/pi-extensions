import {
  errorMessage,
  GUEST_HOME,
  guestReservedOver,
  isJsonObject,
  isLauncherSetVariable,
  isNeverWritten,
  isSecretName,
  isToolConfigKey,
  isWithin,
  LauncherError,
  MAX_WRITE_BACK_CHARS,
  PLACEHOLDER_PREFIX,
  printable,
  TOOL_CONFIG_FORMATS,
  type ToolConfigFormat,
  type ValueType,
  valueSpecProblem,
  writeBackFileProblem,
} from "../shared/index.ts";
import { DEFAULT_SERVICE_USER } from "./defaults.ts";
import { parseHostEntry, SECRET_MARKER } from "./egress-entry.ts";
import {
  at,
  type Check,
  firstProblem,
  joinPath,
  keyPath,
  type ListCheck,
  named,
  type ObjectCheck,
  type ObjectSpec,
  objectProblem,
  type Problem,
  problemOf,
  type Spec,
  shape,
  shown,
} from "./shape.ts";
import type { UserConfig, VolumeEntry } from "./types.ts";
import { builtInKeysOf } from "./write-back.ts";

export const MAX_PORT = 65535;

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const HEADER = /^[A-Za-z0-9-]+$/;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const FINGERPRINT = /^([0-9A-Fa-f]:?){63}[0-9A-Fa-f]$/;

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const JSON_POINTER = /^(\/([^~/]|~[01])*)+$/;

const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

const PRIVATE_HOME_PATHS = [
  ".pi",
  ".ssh",
  ".gnupg",
  ".aws",
  ".docker",
  ".colima",
  ".kube",
  ".config",
  ".local/bin",
];

const VOLUME_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.+-]*$/;

const nonEmpty: Check = (value) => (value.trim() === "" ? "must not be empty" : undefined);

const hostCheck =
  (wildcard: boolean, port: boolean): Check =>
  (value) => {
    const entry = parseHostEntry(value, { wildcard, port });

    return "problem" in entry ? entry.problem : undefined;
  };

const egressEntry = hostCheck(true, true);

const hostName = hostCheck(false, false);

const hostPattern = hostCheck(true, false);

const variable: Check = (value) => (VARIABLE.test(value) ? undefined : "is not an environment variable name");

const launcherSet: Check = (value) =>
  isLauncherSetVariable(value) ? "is set by the launcher and is not forwarded" : undefined;

const forwardableVariable: Check = (value) =>
  variable(value) ??
  launcherSet(value) ??
  (isSecretName(value) ? "looks like a secret and stays on the host" : undefined);

const settableVariable: Check = (value) =>
  variable(value) ?? (isLauncherSetVariable(value) ? "is set by the launcher and cannot be set" : undefined);

const withoutNul: Check = (value) => (value.includes("\0") ? "must not contain a NUL character" : undefined);

const absolutePath: Check = (value) =>
  value.startsWith("/") || value === "~" || value.startsWith("~/")
    ? undefined
    : "must be an absolute path or start with ~/";

const workspaceRootPath: Check = (value) =>
  value === "~" || value === "~/"
    ? "is the home dir, which would share all of it with the sandbox VM"
    : absolutePath(value);

const withoutTrailingSlash = (value: string) => value.replace(/\/$/, "");

const pathSegments = (value: string) => withoutTrailingSlash(value).split("/").slice(1);

export const guestPathOf = (target: string) =>
  target.startsWith("~/")
    ? `${GUEST_HOME}/${pathSegments(target).join("/")}`
    : withoutTrailingSlash(target) || "/";

const privateHomeDir = (value: string) => {
  const path = pathSegments(value).join("/");

  return PRIVATE_HOME_PATHS.find((dir) => path === dir || path.startsWith(`${dir}/`));
};

const guestTarget: Check = (value) => {
  if (!value.startsWith("/") && !value.startsWith("~/")) {
    return "must be an absolute path or start with ~/";
  }

  if (pathSegments(value).some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must not hold empty, . or .. segments";
  }

  const privateDir = value.startsWith("~/") ? privateHomeDir(value) : undefined;

  if (privateDir !== undefined) {
    return `must not be or lie under ~/${privateDir}`;
  }

  if (value.startsWith("/") && isWithin(value, GUEST_HOME)) {
    return `lies in ${GUEST_HOME}; write it as ~/${pathSegments(value).slice(2).join("/")}`;
  }

  const reserved = guestReservedOver(guestPathOf(value));

  return reserved === undefined ? undefined : `overlaps ${reserved}, which the sandbox needs`;
};

const volumeName: Check = (value) =>
  VOLUME_NAME.test(value) ? undefined : "must be lowercase letters, digits, dot, dash or underscore";

const httpsUrl: Check = (value) =>
  URL.canParse(value) && new URL(value).protocol === "https:" ? undefined : "must be an https URL";

const header: Check = (value) => (HEADER.test(value) ? undefined : "must be a header name");

const digest: Check = (value) => (DIGEST.test(value) ? undefined : "must look like sha256:<64 hex digits>");

const fingerprint: Check = (value) =>
  FINGERPRINT.test(value) ? undefined : "must be 64 hex digits, colons optional";

const ruleId: Check = (value) =>
  RULE_ID.test(value) ? undefined : "must be letters, digits, dot, dash or underscore";

const pathPrefix: Check = (value) => (value.startsWith("/") ? undefined : "must start with /");

const placeholder: Check = (value) =>
  value.startsWith(PLACEHOLDER_PREFIX) && value.length > PLACEHOLDER_PREFIX.length
    ? undefined
    : `must start with ${PLACEHOLDER_PREFIX}`;

const template: Check = (value) =>
  value.includes(SECRET_MARKER) ? undefined : `must contain ${SECRET_MARKER}`;

const jsonPointer: Check = (value) => (JSON_POINTER.test(value) ? undefined : "must be a JSON pointer");

const aptPackage: Check = (value) => (APT_PACKAGE.test(value) ? undefined : "must be a package name");

const npmPackage: Check = (value) =>
  NPM_PACKAGE.test(value) ? undefined : "must be an npm name@version, no URL, path or git source";

const notEmptyList: ListCheck = (value) => (value.length === 0 ? "must not be empty" : undefined);

const command: ListCheck = (value) => {
  if (value.length === 0) {
    return "must not be empty";
  }

  return String(value[0]).trim() === "" ? "must name a command first" : undefined;
};

const firstDuplicate = <T>(values: T[]) => values.find((value, index) => values.indexOf(value) !== index);

const firstNested = (paths: string[]) =>
  paths.find((path) => paths.some((other) => other !== path && isWithin(path, other)));

const uniqueIds: ListCheck = (value) =>
  firstDuplicate(value.map((item) => fieldOf(item, "id"))) === undefined ? undefined : "has a duplicate id";

const pinnedReference: ObjectCheck = (value) =>
  (value.reference === undefined) !== (value.digest === undefined)
    ? "sets reference and digest only together: the image is pulled by its digest, or built here without either"
    : undefined;

const ruleMode: ObjectCheck = (value) => {
  if (value.placeholder === undefined && value.header === undefined) {
    return "needs a placeholder or a header";
  }

  return value.template !== undefined && value.header === undefined ? "template needs a header" : undefined;
};

const oneUrlPart: ObjectCheck = (value) =>
  value.urlPassword !== undefined && value.urlUsername !== undefined
    ? "sets both urlPassword and urlUsername"
    : undefined;

const fileSecretMode: ObjectCheck = (value) => {
  const selected = [value.format, value.key, value.urlPassword, value.urlUsername].some(
    (field) => field !== undefined,
  );

  if (value.pointer !== undefined) {
    return selected ? "sets pointer together with format, key, urlPassword or urlUsername" : undefined;
  }

  const both = oneUrlPart(value);

  if (both !== undefined) {
    return both;
  }

  if (value.format === undefined || value.key === undefined) {
    return "needs a pointer, or a format and a key";
  }

  return isToolConfigKey(value.format as ToolConfigFormat, String(value.key))
    ? undefined
    : `key does not fit the ${String(value.format)} format`;
};

const text = (check?: Check): Spec => ({ type: "string", check });

const namedText = (check: Check): Spec => ({ type: "string", check, named: true });

const choice = (values: readonly string[]): Spec => ({ type: "string", values });

const list = (check?: Check): Spec => ({ type: "array", items: text(check) });

const namedList = (check: Check): Spec => ({ type: "array", items: namedText(check) });

const positive: Spec = { type: "number", exclusiveMinimum: 0 };

const port: Spec = { type: "number", exclusiveMinimum: 0, maximum: MAX_PORT, integer: true };

const flag: Spec = { type: "boolean" };

const SECRET_REF: Spec = {
  type: "keyed",
  variants: {
    env: {
      ...shape({ env: text(variable), urlPassword: { type: "true" }, urlUsername: { type: "true" } }, [
        "env",
      ]),
      check: oneUrlPart,
    },
    file: {
      ...shape(
        {
          file: text(absolutePath),
          pointer: text(jsonPointer),
          format: choice(TOOL_CONFIG_FORMATS),
          key: text(nonEmpty),
          urlPassword: { type: "true" },
          urlUsername: { type: "true" },
        },
        ["file"],
      ),
      check: fileSecretMode,
    },
    command: shape({ command: { type: "array", items: text(nonEmpty), check: notEmptyList } }, ["command"]),
    piAuth: shape({ piAuth: text(nonEmpty), bearer: flag }, ["piAuth"]),
    mcpOAuth: shape({ mcpOAuth: shape({ server: text(nonEmpty), url: text(httpsUrl) }, ["server", "url"]) }, [
      "mcpOAuth",
    ]),
  },
};

const CREDENTIAL_RULE: ObjectSpec = {
  type: "object",
  required: ["id", "host", "secret"],
  check: ruleMode,
  properties: {
    id: text(ruleId),
    host: text(hostName),
    port,
    pathPrefix: text(pathPrefix),
    placeholder: text(placeholder),
    header: text(header),
    template: text(template),
    secret: SECRET_REF,
  },
};

const EXTRA_CA: Spec = {
  type: "keyed",
  variants: {
    sha256: shape({ sha256: text(fingerprint) }, ["sha256"]),
    file: shape({ file: namedText(absolutePath) }, ["file"]),
  },
};

const WRITE_BACK_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const MAX_KEY_CHARS = 100;

const anyNumber: Spec = { type: "number" };

const wholeNumber: Spec = { type: "number", integer: true };

const orderedRange: ObjectCheck = (value) =>
  typeof value.min === "number" && typeof value.max === "number" && value.min > value.max
    ? "sets min above max"
    : undefined;

const scalarProblem = (value: unknown, path: string): Problem | undefined => {
  if (typeof value === "string") {
    return at(
      path,
      value.length > MAX_WRITE_BACK_CHARS ? `must be at most ${MAX_WRITE_BACK_CHARS} characters` : undefined,
    );
  }

  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    ? undefined
    : { path, problem: "must be a string, a number or true or false" };
};

const typed = (properties: Record<string, Spec>, required: readonly string[] = []) =>
  shape({ type: text(), ...properties }, ["type", ...required]);

export const MAX_ANY_OF_DEPTH = 4;

const VALUE_SPECS: Record<Exclude<ValueType, "anyOf">, ObjectSpec> = {
  string: typed({ maxLength: { type: "number", minimum: 1, maximum: MAX_WRITE_BACK_CHARS, integer: true } }),
  boolean: typed({}),
  integer: { ...typed({ min: wholeNumber, max: wholeNumber }), check: orderedRange },
  number: { ...typed({ min: anyNumber, max: anyNumber }), check: orderedRange },
  enum: typed(
    { values: { type: "array", items: { type: "custom", problem: scalarProblem }, check: notEmptyList } },
    ["values"],
  ),
  stringList: typed({ maxItems: { type: "number", minimum: 1, integer: true } }),
  fileName: typed({}),
  json: typed({}),
};

const anyOfSpec = (depth: number): ObjectSpec =>
  typed(
    {
      of: {
        type: "array",
        items: { type: "custom", problem: (value, path) => valueSpecAt(value, path, depth + 1) },
        check: notEmptyList,
      },
    },
    ["of"],
  );

const VALUE_TYPES: readonly ValueType[] = [...(Object.keys(VALUE_SPECS) as ValueType[]), "anyOf"];

const isValueType = (value: unknown): value is ValueType => VALUE_TYPES.includes(value as ValueType);

const valueSpecAt = (value: unknown, path: string, depth = 1): Problem | undefined => {
  if (!isJsonObject(value)) {
    return { path, problem: "must be an object" };
  }

  if (!isValueType(value.type)) {
    return { path: joinPath(path, "type"), problem: `must be one of ${VALUE_TYPES.join(", ")}` };
  }

  if (value.type !== "anyOf") {
    return objectProblem(VALUE_SPECS[value.type], value, path);
  }

  return depth > MAX_ANY_OF_DEPTH
    ? { path, problem: `nests anyOf more than ${MAX_ANY_OF_DEPTH} levels deep` }
    : objectProblem(anyOfSpec(depth), value, path);
};

const excludedKeysAt = (file: string, keys: unknown, path: string): Problem | undefined => {
  const builtIn = builtInKeysOf(file);

  if (builtIn === undefined) {
    return { path, problem: "is not a file of the built-in write-back list" };
  }

  const listed = problemOf(list(), keys, path);

  if (listed !== undefined) {
    return listed;
  }

  return firstProblem(
    (keys as string[]).map(
      (key, index) => () =>
        Object.hasOwn(builtIn, key)
          ? undefined
          : {
              path: `${path}[${index}]`,
              problem: `${shown(key)} is not a built-in write-back key of ${file}`,
            },
    ),
  );
};

const excludeAt = (value: unknown, path: string): Problem | undefined =>
  isJsonObject(value)
    ? firstProblem(
        Object.entries(value).map(
          ([file, keys]) =>
            () =>
              excludedKeysAt(file, keys, keyPath(path, file)),
        ),
      )
    : { path, problem: "must be an object" };

const addedKeyProblem = (file: string, key: string) => {
  if (!WRITE_BACK_KEY.test(key) || key.length > MAX_KEY_CHARS) {
    return "must be a key name of letters, digits, dash or underscore, starting with a letter";
  }

  return isNeverWritten(file, key) ? `is host-owned and never written back to the host` : undefined;
};

const addedKeyAt = (file: string, key: string, spec: unknown, path: string) =>
  firstProblem([
    () => at(path, addedKeyProblem(file, key)),
    () => valueSpecAt(spec, path),
    () => at(path, valueSpecProblem(file, key, spec as never)),
  ]);

const addedFileAt = (file: string, keys: unknown, path: string): Problem | undefined => {
  const fileProblem = writeBackFileProblem(file);

  if (fileProblem !== undefined) {
    return { path, problem: fileProblem };
  }

  return isJsonObject(keys)
    ? firstProblem(
        Object.entries(keys).map(
          ([key, spec]) =>
            () =>
              addedKeyAt(file, key, spec, keyPath(path, key)),
        ),
      )
    : { path, problem: "must be an object" };
};

const addAt = (value: unknown, path: string): Problem | undefined =>
  isJsonObject(value)
    ? firstProblem(
        Object.entries(value).map(
          ([file, keys]) =>
            () =>
              addedFileAt(file, keys, keyPath(path, file)),
        ),
      )
    : { path, problem: "must be an object" };

const excludedAndAdded: ObjectCheck = (value) => {
  const exclude = (value.exclude ?? {}) as Record<string, string[]>;
  const add = (value.add ?? {}) as Record<string, Record<string, unknown>>;
  const clash = Object.entries(exclude)
    .flatMap(([file, keys]) => keys.map((key) => [file, key] as const))
    .find(([file, key]) => Object.hasOwn(add, file) && Object.hasOwn(add[file], key));

  return clash === undefined ? undefined : `excludes and adds ${clash[1]} of ${clash[0]}`;
};

const VOLUME = shape({ target: namedText(guestTarget), name: text(volumeName) }, ["target"]);

const volumeAt = (value: unknown, path: string): Problem | undefined =>
  typeof value === "string" ? at(path, named(value, guestTarget(value))) : problemOf(VOLUME, value, path);

const BIND = shape({ source: namedText(absolutePath), target: namedText(guestTarget) }, ["source", "target"]);

const nameOf = (entry: unknown) =>
  isJsonObject(entry) && typeof entry.name === "string" ? entry.name : undefined;

const distinctVolumeNames: ListCheck = (value) => {
  const duplicate = firstDuplicate(value.flatMap((entry) => nameOf(entry) ?? []));

  return duplicate === undefined ? undefined : `names the volume ${duplicate} twice`;
};

const targetOf = (entry: unknown) => String(isJsonObject(entry) ? entry.target : entry);

const apartTargets: ObjectCheck = (value) => {
  const lists = [value.volumes, value.binds].map((list) => (Array.isArray(list) ? list : []));
  const targets = lists.flat().map((entry) => guestPathOf(targetOf(entry)));
  const duplicate = firstDuplicate(targets);

  if (duplicate !== undefined) {
    return `lists the target ${duplicate} twice`;
  }

  const nested = firstNested(targets);

  return nested === undefined ? undefined : `lists the target ${nested} inside another target`;
};

const WRITE_BACK: ObjectSpec = {
  ...shape({
    enabled: flag,
    exclude: { type: "custom", problem: excludeAt },
    add: { type: "custom", problem: addAt },
  }),
  check: excludedAndAdded,
};

export const VM_BOUNDS = {
  cpus: { min: 1, max: 64 },
  memoryGiB: { min: 2, max: 256 },
  diskGiB: { min: 20, max: 2048 },
} as const;

const wholeWithin = (minimum: number, maximum: number): Spec => ({
  type: "number",
  minimum,
  maximum,
  integer: true,
});

export const RESOURCE_BOUNDS = {
  pids: { min: 256, max: 4194304 },
  openFiles: { min: 1024, max: 1048576 },
  shmMiB: { min: 1, max: VM_BOUNDS.memoryGiB.max * 1024 },
} as const;

const RESOURCE_KEYS = ["cpus", "memoryGiB"] as const;

const serviceMemoryOf = (services: unknown) =>
  (Array.isArray(services) ? services : []).reduce<number>(
    (sum, service) =>
      sum + (isJsonObject(service) && typeof service.memoryGiB === "number" ? service.memoryGiB : 0),
    0,
  );

const memoryWithinVm = (
  agent: number | undefined,
  services: number,
  vm: number | undefined,
  vmName: string,
) => {
  if (vm === undefined || services === 0 || (agent ?? 0) + services <= vm) {
    return undefined;
  }

  return `resources.memoryGiB ${agent ?? 0} plus the services' memoryGiB ${services} is larger than ${vmName}; the agent and every service share the VM`;
};

export const defaultVmMemoryProblem = (
  config: { resources: { memoryGiB?: number }; services: Array<{ memoryGiB?: number }> },
  defaultGiB: number,
) => {
  const agent = config.resources.memoryGiB;
  const vmName = `the ${defaultGiB} GiB the VM gets by default on this Mac (vm.memoryGiB is not set)`;

  if (agent !== undefined && agent > defaultGiB) {
    return `resources.memoryGiB ${agent} is larger than ${vmName}; resources limits one container inside the VM`;
  }

  return memoryWithinVm(agent, serviceMemoryOf(config.services), defaultGiB, vmName);
};

const resourcesWithinVm: ObjectCheck = (value) => {
  const resources = (value.resources ?? {}) as Record<string, number | undefined>;
  const vm = (value.vm ?? {}) as Record<string, number | undefined>;
  const larger = RESOURCE_KEYS.find((key) => (resources[key] ?? 0) > (vm[key] ?? Number.POSITIVE_INFINITY));

  if (larger !== undefined) {
    return `resources.${larger} ${resources[larger]} is larger than vm.${larger} ${vm[larger]}; resources limits one container inside the VM`;
  }

  return memoryWithinVm(
    resources.memoryGiB,
    serviceMemoryOf(value.services),
    vm.memoryGiB,
    `vm.memoryGiB ${vm.memoryGiB}`,
  );
};

const agentVolumeNames = (mounts: unknown) => {
  const volumes = fieldOf(mounts, "volumes");

  return (Array.isArray(volumes) ? volumes : [])
    .map((entry) => fieldOf(entry, "name"))
    .filter((name) => name !== undefined);
};

const agentSharesAsDefaultUser: ObjectCheck = (value) => {
  const shared = new Set<unknown>(agentVolumeNames(value.mounts));
  const services = Array.isArray(value.services) ? value.services : [];
  const clash = volumeUsers(services).find(
    (entry) => shared.has(entry.name) && entry.user !== DEFAULT_SERVICE_USER,
  );

  return clash === undefined
    ? undefined
    : `services: mounts the volume ${String(clash.name)} as ${clash.user}, but mounts.volumes shares it with the agent, so every service that mounts it runs as ${DEFAULT_SERVICE_USER}`;
};

const configCheck: ObjectCheck = (value) => resourcesWithinVm(value) ?? agentSharesAsDefaultUser(value);

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

const SERVICE_USER = /^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/;

export const MAX_READY_SECONDS = 3600;

const serviceName: Check = (value) =>
  SERVICE_NAME.test(value)
    ? undefined
    : "must start with a lowercase letter and hold at most 31 lowercase letters, digits or dashes";

const MAX_SERVICE_ID = 2147483647;

const serviceUser: Check = (value) => {
  if (!SERVICE_USER.test(value)) {
    return "must be uid:gid, two numbers above 0 without leading zeros";
  }

  return value.split(":").some((id) => Number(id) > MAX_SERVICE_ID)
    ? `must be uid:gid, each at most ${MAX_SERVICE_ID}`
    : undefined;
};

const MOUNT_SEPARATORS = /[:,]/;

const servicePath: Check = (value) => {
  if (!value.startsWith("/") || value === "/") {
    return "must be an absolute path other than /";
  }

  if (MOUNT_SEPARATORS.test(value)) {
    return "must not hold : or , (the container engine reads them as separators)";
  }

  return value
    .slice(1)
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..")
    ? "must be a normalised path: no trailing slash and no empty, . or .. segments"
    : undefined;
};

const SERVICE_TMP = "/tmp";

const pathsApart: ObjectCheck = (value) => {
  const volumes = Array.isArray(value.volumes) ? value.volumes : [];
  const tmpfs = Array.isArray(value.tmpfs) ? value.tmpfs : [];
  const paths = [SERVICE_TMP, ...volumes.map(targetOf), ...tmpfs.map(String)];
  const duplicate = firstDuplicate(paths);

  if (duplicate !== undefined) {
    return `lists ${duplicate} twice (${SERVICE_TMP} is always a tmpfs)`;
  }

  const nested = firstNested(paths);

  return nested === undefined ? undefined : `lists ${nested} inside another volume target or tmpfs path`;
};

const SERVICE: ObjectSpec = {
  ...shape(
    {
      name: text(serviceName),
      image: text(nonEmpty),
      command: { type: "array", items: text(withoutNul), check: command },
      user: text(serviceUser),
      env: { type: "map", key: variable, value: text(withoutNul) },
      volumes: {
        type: "array",
        items: shape({ name: text(volumeName), target: namedText(servicePath) }, ["name", "target"]),
      },
      tmpfs: namedList(servicePath),
      ready: shape(
        {
          command: { type: "array", items: text(withoutNul), check: command },
          timeoutSeconds: wholeWithin(1, MAX_READY_SECONDS),
        },
        ["command"],
      ),
      memoryGiB: positive,
      shmMiB: wholeWithin(RESOURCE_BOUNDS.shmMiB.min, RESOURCE_BOUNDS.shmMiB.max),
      ports: { type: "array", items: wholeWithin(1, MAX_PORT) },
    },
    ["name", "command"],
  ),
  check: pathsApart,
};

const fieldOf = (entry: unknown, key: string) => (isJsonObject(entry) ? entry[key] : undefined);

const distinctServiceNames: ListCheck = (value) => {
  const duplicate = firstDuplicate(value.map((service) => fieldOf(service, "name")));

  return duplicate === undefined ? undefined : `names the service ${String(duplicate)} twice`;
};

const volumeUsers = (value: unknown[]) =>
  value.flatMap((service) => {
    const user = String(fieldOf(service, "user") ?? DEFAULT_SERVICE_USER);
    const volumes = fieldOf(service, "volumes");

    return (Array.isArray(volumes) ? volumes : []).map((volume) => ({ name: fieldOf(volume, "name"), user }));
  });

const oneUserPerVolume: ListCheck = (value) => {
  const users = volumeUsers(value);
  const clash = users.find((entry) =>
    users.some((other) => other.name === entry.name && other.user !== entry.user),
  );

  return clash === undefined ? undefined : `mounts the volume ${String(clash.name)} as two different users`;
};

const distinctPorts: ListCheck = (value) => {
  const ports = value.flatMap((service) => {
    const listed = fieldOf(service, "ports");

    return Array.isArray(listed) ? listed : [];
  });
  const duplicate = firstDuplicate(ports);

  return duplicate === undefined ? undefined : `lists the port ${String(duplicate)} twice`;
};

const servicesCheck: ListCheck = (value) =>
  distinctServiceNames(value) ?? oneUserPerVolume(value) ?? distinctPorts(value);

const CONFIG_SPEC: ObjectSpec = {
  type: "object",
  check: configCheck,
  properties: {
    $schema: text(),
    image: {
      ...shape({
        reference: text(nonEmpty),
        digest: text(digest),
        packages: namedList(aptPackage),
        npmGlobal: list(npmPackage),
        dockerfile: namedText(absolutePath),
      }),
      check: pinnedReference,
    },
    credentials: shape({
      rules: { type: "array", items: CREDENTIAL_RULE, check: uniqueIds },
      derive: shape({ enabled: flag, hosts: list(hostPattern) }),
    }),
    egress: shape({
      allow: list(egressEntry),
      deny: list(egressEntry),
      privateHosts: list(hostPattern),
    }),
    tls: shape({ extraCa: { type: "array", items: EXTRA_CA } }),
    workspaceRoot: namedText(workspaceRootPath),
    mounts: {
      ...shape({
        volumes: {
          type: "array",
          items: { type: "custom", problem: volumeAt, keys: VOLUME },
          check: distinctVolumeNames,
        },
        binds: { type: "array", items: BIND },
        autoOverlays: flag,
      }),
      check: apartTargets,
    },
    env: {
      type: "object",
      properties: {
        allow: namedList(forwardableVariable),
        set: { type: "map", key: settableVariable, value: text(withoutNul) },
      },
    },
    resources: {
      type: "object",
      properties: {
        cpus: positive,
        memoryGiB: positive,
        pids: wholeWithin(RESOURCE_BOUNDS.pids.min, RESOURCE_BOUNDS.pids.max),
        openFiles: wholeWithin(RESOURCE_BOUNDS.openFiles.min, RESOURCE_BOUNDS.openFiles.max),
        shmMiB: wholeWithin(RESOURCE_BOUNDS.shmMiB.min, RESOURCE_BOUNDS.shmMiB.max),
      },
    },
    vm: shape({
      cpus: wholeWithin(VM_BOUNDS.cpus.min, VM_BOUNDS.cpus.max),
      memoryGiB: wholeWithin(VM_BOUNDS.memoryGiB.min, VM_BOUNDS.memoryGiB.max),
      diskGiB: wholeWithin(VM_BOUNDS.diskGiB.min, VM_BOUNDS.diskGiB.max),
      releaseFileCache: flag,
    }),
    sessions: shape({ host: flag }),
    terminal: shape({ clipboard: flag }),
    writeBack: WRITE_BACK,
    setup: { type: "array", items: { type: "array", items: text(withoutNul), check: command } },
    services: { type: "array", items: SERVICE, check: servicesCheck },
  },
};

const normalizedVolume = (entry: string | VolumeEntry) =>
  typeof entry === "string"
    ? withoutTrailingSlash(entry)
    : { ...entry, target: withoutTrailingSlash(entry.target) };

const normalized = (config: UserConfig): UserConfig => {
  const volumes = config.mounts?.volumes;

  return volumes === undefined
    ? config
    : { ...config, mounts: { ...config.mounts, volumes: volumes.map(normalizedVolume) } };
};

const REPLACED_KEYS: Record<string, string> = {
  workspaceRoots:
    'workspaceRoots was replaced by workspaceRoot, one folder: write "workspaceRoot": "~/work" in its place, or remove the key and run pi sandbox init',
};

export const validateConfig = (value: unknown): UserConfig => {
  const found = problemOf(CONFIG_SPEC, value, "");

  if (found !== undefined) {
    const message = found.path === "" ? found.problem : `${found.path} ${found.problem}`;

    throw new LauncherError(
      `config: ${printable(message)}`,
      Object.hasOwn(REPLACED_KEYS, found.path) ? REPLACED_KEYS[found.path] : undefined,
    );
  }

  return normalized(value as UserConfig);
};

export const configProblem = (value: unknown) => {
  try {
    validateConfig(value);

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const keysOf = (spec: Spec, path: string): string[] => {
  if (spec.type === "object") {
    return Object.entries(spec.properties).flatMap(([key, child]) => [
      joinPath(path, key),
      ...keysOf(child, joinPath(path, key)),
    ]);
  }

  if (spec.type === "keyed") {
    return [...new Set(Object.values(spec.variants).flatMap((variant) => keysOf(variant, path)))];
  }

  if (spec.type === "custom") {
    return spec.keys === undefined ? [] : keysOf(spec.keys, path);
  }

  return spec.type === "array" ? keysOf(spec.items, `${path}[]`) : [];
};

export const configKeys = () => keysOf(CONFIG_SPEC, "");

const leavesOf = (spec: Spec, path: string): string[] =>
  spec.type === "object" && spec.atomic !== true
    ? Object.entries(spec.properties).flatMap(([key, child]) => leavesOf(child, joinPath(path, key)))
    : [path];

export const leafKeys = () => leavesOf(CONFIG_SPEC, "").filter((key) => key !== "$schema");
