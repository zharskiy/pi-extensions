export interface NpmrcEntry {
  key: string;
  value: string;
}

const NPMRC_LINE = /^\s*([^\s=;#][^=]*?)\s*=\s*(.*?)\s*$/;

const unquote = (value: string) =>
  /^"(.*)"$/.test(value) || /^'(.*)'$/.test(value) ? value.slice(1, -1) : value;

const decodeBase64 = (value: string) => Buffer.from(value, "base64").toString("utf8");

export const parseNpmrc = (text: string): NpmrcEntry[] =>
  text.split(/\r?\n/).flatMap((line) => {
    const match = NPMRC_LINE.exec(line);

    return match === null ? [] : [{ key: match[1] ?? "", value: unquote(match[2] ?? "") }];
  });

export const npmrcValue = (text: string, key: string) => {
  const value = parseNpmrc(text).findLast((entry) => entry.key === key)?.value;

  if (value === undefined) {
    return undefined;
  }

  if (key.endsWith(":_auth")) {
    const decoded = decodeBase64(value);
    const colon = decoded.indexOf(":");

    return colon < 0 ? undefined : decoded.slice(colon + 1);
  }

  return key.endsWith(":_password") ? decodeBase64(value) : value;
};
