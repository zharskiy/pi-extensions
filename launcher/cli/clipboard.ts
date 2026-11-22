import type { ClipboardContent, HostClipboard, LauncherContainerSpec } from "../container/index.ts";
import type { LaunchContext } from "./context.ts";
import type { CliDeps } from "./deps.ts";

const PBCOPY = "/usr/bin/pbcopy";

const OSASCRIPT = "/usr/bin/osascript";

const CLIPBOARD_TIMEOUT_MS = 5000;

const CLIPBOARD_READ = [
  'use framework "AppKit"',
  "use scripting additions",
  "set board to current application's NSPasteboard's generalPasteboard()",
  "set refs to (board's readObjectsForClasses:{current application's NSURL} options:{NSPasteboardURLReadingFileURLsOnlyKey:true}) as list",
  'if (count of refs) > 1 then error "files"',
  "if refs is not {} then return POSIX path of item 1 of refs",
  "the clipboard as «class PNGf»",
].flatMap((line) => ["-e", line]);

const PNG_HEX = /^«data PNGf([0-9A-Fa-f]+)»/;

const clipboardContent = (stdout: string): ClipboardContent | undefined => {
  if (stdout.startsWith("/")) {
    return { file: stdout.replace(/\n$/, "") };
  }

  const hex = PNG_HEX.exec(stdout)?.[1];

  return hex === undefined ? undefined : { image: Buffer.from(hex, "hex") };
};

export const hostClipboard = (
  deps: CliDeps,
  context: LaunchContext,
  mounts: LauncherContainerSpec["mounts"],
): HostClipboard | undefined => {
  if (deps.platform !== "darwin" || !context.effective.config.terminal.clipboard) {
    return undefined;
  }

  return {
    copy: (text) =>
      deps.runner.run(PBCOPY, [], {
        input: text.toString("utf8"),
        env: { LC_CTYPE: "UTF-8" },
        timeoutMs: CLIPBOARD_TIMEOUT_MS,
      }),
    read: async () => {
      const read = await deps.runner.run(OSASCRIPT, CLIPBOARD_READ, { timeoutMs: CLIPBOARD_TIMEOUT_MS });

      return read.code === 0 ? clipboardContent(read.stdout) : undefined;
    },
    mounts,
  };
};
