import { type ModelChoice, type ModelResolution, splitModelRequest } from "./contract.ts";

export type CatalogModel = {
  provider: string;
  id: string;
  name?: string;
  contextWindow: number;
  cost: { input: number; output: number };
  authenticated: boolean;
};

export type ModelPreferences = { sessionProvider?: string; defaultProvider?: string };

type Tier = 0 | 1 | 2 | 3;

type Match = { model: CatalogModel; tier: Tier; score: number };

const SIMILAR_SCORE = 0.15;

const FUZZY_TOKEN_RATIO = 0.34;

const FUZZY_WHOLE_RATIO = 0.2;

const MIN_FUZZY_TOKEN = 3;

const MAX_CANDIDATES = 6;

const MAX_SUGGESTIONS = 3;

const MIN_SUGGESTION_SIMILARITY = 0.5;

const NON_FAMILY_TOKENS = new Set(["us", "eu", "global", "apac", "au", "jp", "ca", "latest"]);

const DATE_TOKEN = /^\d{8}$/;

const NUMBER_TOKEN = /^\d+$/;

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export const tokensOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/)
    .filter(Boolean);

export const editDistance = (left: string, right: string) => {
  const rows = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );

  Array.from(left).forEach((leftChar, leftIndex) => {
    const row = leftIndex + 1;

    Array.from(right).forEach((rightChar, rightIndex) => {
      const column = rightIndex + 1;
      const cost = leftChar === rightChar ? 0 : 1;

      const best = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      );

      const transposed =
        row > 1 && column > 1 && leftChar === right[column - 2] && left[row - 2] === rightChar
          ? rows[row - 2][column - 2] + 1
          : best;

      rows[row][column] = Math.min(best, transposed);
    });
  });

  return rows[left.length][right.length];
};

const refOf = (model: CatalogModel) => `${model.provider}/${model.id}`;

const choiceOf = (model: CatalogModel): ModelChoice => ({
  ref: refOf(model),
  contextWindow: model.contextWindow,
  cost: model.cost,
});

const versionSource = (id: string) => id.toLowerCase().replace(/-v\d+(:\d+)?$/, "");

const versionOf = (model: CatalogModel) =>
  tokensOf(versionSource(model.id))
    .filter((token) => NUMBER_TOKEN.test(token) && !DATE_TOKEN.test(token))
    .map(Number);

const isDated = (model: CatalogModel) => tokensOf(model.id).some((token) => DATE_TOKEN.test(token));

export const compareVersions = (left: number[], right: number[]): number => {
  const length = Math.max(left.length, right.length);
  const index = Array.from({ length }, (_, position) => position).find(
    (position) => (left[position] ?? -1) !== (right[position] ?? -1),
  );

  if (index === undefined) {
    return 0;
  }

  return (left[index] ?? -1) - (right[index] ?? -1);
};

const providerTokens = (catalog: CatalogModel[]) =>
  new Set(catalog.flatMap((model) => tokensOf(model.provider)));

const familyOf = (model: CatalogModel, ignored: Set<string>) =>
  tokensOf(versionSource(model.id))
    .filter((token) => !NUMBER_TOKEN.test(token) && !NON_FAMILY_TOKENS.has(token) && !ignored.has(token))
    .join("-");

const modelTokens = (model: CatalogModel) => new Set([...tokensOf(model.id), ...tokensOf(model.name ?? "")]);

const fuzzyTokenDistance = (queryToken: string, tokens: Set<string>) => {
  if (tokens.has(queryToken)) {
    return 0;
  }

  if (NUMBER_TOKEN.test(queryToken) || queryToken.length < MIN_FUZZY_TOKEN) {
    return undefined;
  }

  const allowed = Math.max(1, Math.floor(queryToken.length * FUZZY_TOKEN_RATIO));
  const distances = Array.from(tokens)
    .filter((token) => !NUMBER_TOKEN.test(token))
    .map((token) => editDistance(queryToken, token))
    .filter((distance) => distance <= allowed);

  return distances.length > 0 ? Math.min(...distances) : undefined;
};

const fuzzyScore = (query: string, model: CatalogModel) => {
  const queryTokens = tokensOf(query);
  const tokens = modelTokens(model);
  const distances = queryTokens.map((token) => fuzzyTokenDistance(token, tokens));
  const queryLength = Math.max(1, normalise(query).length);

  const tokenScore = distances.every((distance) => distance !== undefined)
    ? 1 - distances.reduce<number>((sum, distance) => sum + (distance ?? 0), 0) / queryLength
    : 0;

  const id = normalise(model.id);
  const wholeDistance = editDistance(normalise(query), id);
  const wholeScore =
    wholeDistance <= Math.floor(id.length * FUZZY_WHOLE_RATIO) ? 1 - wholeDistance / id.length : 0;

  return Math.max(tokenScore, wholeScore);
};

const matchModel = (query: string, model: CatalogModel): Match => {
  const wanted = normalise(query);
  const id = normalise(model.id);

  if (wanted.length === 0) {
    return { model, tier: 0, score: 0 };
  }

  if (id === wanted) {
    return { model, tier: 3, score: 1 };
  }

  const tokens = modelTokens(model);
  const contained = id.includes(wanted) || tokensOf(query).every((token) => tokens.has(token));

  if (contained) {
    return { model, tier: 2, score: Math.min(1, wanted.length / id.length) };
  }

  const score = fuzzyScore(query, model);

  return { model, tier: score > 0 ? 1 : 0, score };
};

const similarity = (query: string, model: CatalogModel) => {
  const queryTokens = tokensOf(query);
  const tokens = Array.from(modelTokens(model));

  if (queryTokens.length === 0 || tokens.length === 0) {
    return 0;
  }

  const total = queryTokens.reduce((sum, queryToken) => {
    const best = Math.max(
      ...tokens.map(
        (token) => 1 - editDistance(queryToken, token) / Math.max(queryToken.length, token.length),
      ),
    );

    return sum + best;
  }, 0);

  return total / queryTokens.length;
};

const preferenceRank = (model: CatalogModel, preferences: ModelPreferences) => {
  if (model.provider === preferences.sessionProvider) {
    return 0;
  }

  if (model.provider === preferences.defaultProvider) {
    return 1;
  }

  return 2;
};

const compareMatches = (preferences: ModelPreferences) => (left: Match, right: Match) => {
  const version = compareVersions(versionOf(right.model), versionOf(left.model));

  if (version !== 0) {
    return version;
  }

  const preference = preferenceRank(left.model, preferences) - preferenceRank(right.model, preferences);

  if (preference !== 0) {
    return preference;
  }

  const dated = Number(isDated(left.model)) - Number(isDated(right.model));

  if (dated !== 0) {
    return dated;
  }

  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.model.id.length !== right.model.id.length) {
    return left.model.id.length - right.model.id.length;
  }

  return refOf(left.model).localeCompare(refOf(right.model));
};

const exactMatches = (ref: string, catalog: CatalogModel[]) => {
  const wanted = ref.toLowerCase();

  return catalog.filter(
    (model) => refOf(model).toLowerCase() === wanted || model.id.toLowerCase() === wanted,
  );
};

const noCredentials = (request: string, providers: string[]): ModelResolution => ({
  kind: "invalid",
  request,
  error: `provider ${providers.map((provider) => `"${provider}"`).join(", ")} has no credentials for "${request}"; the user can log in with /login`,
});

const fromExact = (
  request: string,
  matches: CatalogModel[],
  preferences: ModelPreferences,
  thinking: string | undefined,
): ModelResolution => {
  const usable = matches.filter((model) => model.authenticated);

  if (usable.length === 0) {
    return noCredentials(request, Array.from(new Set(matches.map((model) => model.provider))));
  }

  const ranked = usable
    .map((model): Match => ({ model, tier: 3, score: 1 }))
    .sort(compareMatches(preferences));

  return { kind: "resolved", request, model: choiceOf(ranked[0].model), thinking };
};

const scopeOf = (name: string, catalog: CatalogModel[]) => {
  const slash = name.indexOf("/");

  if (slash < 0) {
    return { pool: catalog, query: name, provider: undefined };
  }

  const provider = name.slice(0, slash).toLowerCase();
  const pool = catalog.filter((model) => model.provider.toLowerCase() === provider);

  if (pool.length === 0) {
    return { pool: catalog, query: name.slice(slash + 1), provider: undefined };
  }

  return { pool, query: name.slice(slash + 1), provider: pool[0].provider };
};

const unknownResult = (request: string, query: string, pool: CatalogModel[], matches: Match[]) => {
  const withoutCredentials = matches
    .filter((match) => !match.model.authenticated)
    .sort((left, right) => right.tier - left.tier || compareMatches({})(left, right))
    .slice(0, MAX_CANDIDATES)
    .map((match) => choiceOf(match.model));

  if (withoutCredentials.length > 0) {
    return { kind: "unknown" as const, request, candidates: [], withoutCredentials };
  }

  const candidates = pool
    .filter((model) => model.authenticated)
    .map((model) => ({ model, score: similarity(query, model) }))
    .filter((entry) => entry.score >= MIN_SUGGESTION_SIMILARITY)
    .sort((left, right) => right.score - left.score || refOf(left.model).localeCompare(refOf(right.model)))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => choiceOf(entry.model));

  return { kind: "unknown" as const, request, candidates, withoutCredentials };
};

export const resolveModel = (
  request: string,
  catalog: CatalogModel[],
  preferences: ModelPreferences = {},
): ModelResolution => {
  const trimmed = request.trim();
  const whole = exactMatches(trimmed, catalog);

  if (whole.length > 0) {
    return fromExact(trimmed, whole, preferences, undefined);
  }

  const parsed = splitModelRequest(trimmed);

  if (parsed.error) {
    return { kind: "invalid", request: trimmed, error: parsed.error };
  }

  if (parsed.name.length === 0) {
    return { kind: "invalid", request: trimmed, error: `model "${trimmed}" has no name` };
  }

  const named = exactMatches(parsed.name, catalog);

  if (named.length > 0) {
    return fromExact(trimmed, named, preferences, parsed.thinking);
  }

  const scope = scopeOf(parsed.name, catalog);

  if (scope.provider && !scope.pool.some((model) => model.authenticated)) {
    return noCredentials(trimmed, [scope.provider]);
  }

  const matches = scope.pool.map((model) => matchModel(scope.query, model)).filter((match) => match.tier > 0);
  const usable = matches.filter((match) => match.model.authenticated);

  if (usable.length === 0) {
    return unknownResult(trimmed, scope.query, scope.pool, matches);
  }

  const topTier = Math.max(...usable.map((match) => match.tier));
  const inTier = usable.filter((match) => match.tier === topTier);
  const topScore = Math.max(...inTier.map((match) => match.score));
  const ignored = providerTokens(catalog);
  const families = new Map<string, Match[]>();

  inTier.forEach((match) => {
    const family = familyOf(match.model, ignored);
    const members = families.get(family) ?? [];

    members.push(match);
    families.set(family, members);
  });

  const order = compareMatches(preferences);
  const bestScore = (members: Match[]) => Math.max(...members.map((match) => match.score));

  const contenders = Array.from(families.values())
    .filter((members) => bestScore(members) >= topScore - SIMILAR_SCORE)
    .map((members) => members.sort(order))
    .sort((left, right) => bestScore(right) - bestScore(left));

  if (contenders.length > 1) {
    return {
      kind: "ambiguous",
      request: trimmed,
      candidates: contenders.slice(0, MAX_CANDIDATES).map((members) => choiceOf(members[0].model)),
    };
  }

  return {
    kind: "resolved",
    request: trimmed,
    model: choiceOf(contenders[0][0].model),
    thinking: parsed.thinking,
  };
};
