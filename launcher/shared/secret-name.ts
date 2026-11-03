const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;

export const isSecretName = (name: string) => SECRET_NAME.test(name);
