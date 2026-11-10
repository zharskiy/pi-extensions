const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|JWT)/i;

export const isSecretName = (name: string) => SECRET_NAME.test(name);

export const isAuthLikeHeader = (name: string) => {
  const lower = name.toLowerCase();

  return lower !== "proxy-authorization" && (lower === "authorization" || isSecretName(lower));
};
