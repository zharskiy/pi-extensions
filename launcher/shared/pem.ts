const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export const pemCertificates = (text: string) => text.match(PEM_BLOCK) ?? [];
