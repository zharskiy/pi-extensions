import { spawn } from "node:child_process";

export type OpenBrowser = (url: string) => Promise<void>;

const browserCommand = (platform: NodeJS.Platform) => (platform === "darwin" ? "open" : "xdg-open");

export const openInBrowser =
  (platform: NodeJS.Platform = process.platform): OpenBrowser =>
  (url) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(browserCommand(platform), [url], { detached: true, stdio: "ignore", shell: false });

      child.once("error", reject);

      child.once("spawn", () => {
        child.unref();

        resolve();
      });
    });
