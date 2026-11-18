const DEFAULT_TAG = "latest";

export const repositoryOf = (reference: string) => {
  const at = reference.indexOf("@");
  const name = at >= 0 ? reference.slice(0, at) : reference;
  const colon = name.lastIndexOf(":");

  return colon > name.lastIndexOf("/") ? name.slice(0, colon) : name;
};

export const tagOf = (reference: string) => {
  const rest = reference.slice(repositoryOf(reference).length);
  const [tag = "", pinned] = rest.slice(1).split("@");

  return rest.startsWith("@") ? rest.slice(1) : (pinned ?? (tag || DEFAULT_TAG));
};

export const pinnedReference = (reference: string, digest: string) => `${repositoryOf(reference)}@${digest}`;
