import { randomBytes } from "node:crypto";

export const OAUTH_ROUTES = {
  open: "/oauth/open",
  callback: "/oauth/callback",
  cancel: "/oauth/cancel",
} as const;

export const OAUTH_AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "state",
  "scope",
  "prompt",
  "resource",
] as const;

export interface OAuthOpenRequest {
  url: string;
}

export type OAuthOpenReply =
  | { ok: true; flow: string; port: number; path: string }
  | { ok: false; error: string };

export type OAuthCallbackReply =
  | { status: "ready"; query: string }
  | { status: "pending" }
  | { status: "gone"; error?: string };

export const OAUTH_CALLBACK_STATUS = { ready: 200, pending: 204, gone: 410 } as const;

export type OAuthCancelReply = { ok: true } | { ok: false; error: string };

const CODE_PREFIX = "pi-sandbox-code-";

const CODE_BYTES = 16;

const CODE = new RegExp(`^${CODE_PREFIX}[0-9a-f]{${CODE_BYTES * 2}}$`);

export const codePlaceholder = () => `${CODE_PREFIX}${randomBytes(CODE_BYTES).toString("hex")}`;

export const isCodePlaceholder = (value: string) => CODE.test(value);
