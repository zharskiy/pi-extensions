import { readFileSync } from "node:fs";

const [file, provider, modelId, baseUrl, ...path] = process.argv.slice(2);

const withoutUserinfo = (url) => {
  if (typeof url !== "string" || url === "") {
    return "";
  }

  try {
    const parsed = new URL(url);

    parsed.username = "";

    parsed.password = "";

    return parsed.href;
  } catch {
    return "";
  }
};

const readModels = () => {
  try {
    const models = JSON.parse(readFileSync(file, "utf8"))?.providers?.[provider]?.models;

    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
};

const model = readModels().find(
  (entry) => entry?.id === modelId && withoutUserinfo(entry?.baseUrl) === baseUrl,
);
const value = path.reduce(
  (current, key) => (current !== null && typeof current === "object" ? current[key] : undefined),
  model,
);

if (typeof value !== "string" || value === "") {
  process.stderr.write(
    `${file}: model ${modelId} of ${provider} at ${baseUrl || "the provider url"} has no ${path.join(".")}\n`,
  );

  process.exit(1);
}

process.stdout.write(value);
