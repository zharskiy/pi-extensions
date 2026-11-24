import { dirname } from "node:path";
import { sessionsRunning, type VmApplied, type VmPhase, type VmSpec } from "../../backend/index.ts";
import { isWithin } from "../../shared/index.ts";
import { printable, widthOf, wrap } from "../prompt/style.ts";
import { tildeForm } from "./folders.ts";
import { existingVm, type VmBounds } from "./plan.ts";
import type {
  Answers,
  ApplyEvent,
  Change,
  DocumentRead,
  FolderCandidate,
  HostFacts,
  Plan,
  VmAction,
  VmPart,
} from "./types.ts";

export type Tag = "chosen" | "current" | "changed" | "automatic" | "default" | "invalid";

export interface HubRow {
  label: string;
  value: string;
  tag: Tag;
  problems: string[];
}

export interface Step {
  index: number;
  count: number;
}

const LABEL_WIDTH = 19;

const HUB_TAGS_INLINE = 56;

export const INTRO_TITLE = "pinata setup";

export const CHECKING = "Checking this Mac and the sandbox VM…";

export const OTHER_SETTINGS =
  "Network access, image packages, credentials and the other settings are in the same file; this setup does not change them.";

export const HUB_SUMMARY_TITLE = "Your settings:";

export const FOLDERS_TITLE = "Which folder holds your projects?";

export const FOLDERS_DETAIL =
  "Only this folder is shared with the sandbox VM, besides pi's sessions folder and pinata's read-only state/vm folder, and pi starts only inside it. It cannot be your home or a folder that holds it.";

export const OTHER_FOLDER_TITLE = "Type the folder that holds your projects";

export const NO_FOLDER_FOUND =
  "No usual project folder was found in your home. Choose the folder that holds your projects.";

export const SEARCH_TIMED_OUT =
  "Looking for project folders took too long. Choose the folder that holds your projects.";

const workspaceShares = (facts: HostFacts) => {
  const vm = existingVm(facts);

  if (vm === undefined || vm.shares === "unreadable") {
    return undefined;
  }

  const agentDir = dirname(dirname(facts.configFile));

  return vm.shares
    .map((share) => share.location)
    .filter((location) => location !== agentDir && !isWithin(location, agentDir));
};

export const sharedNowLine = (facts: HostFacts) => {
  const locations = workspaceShares(facts);

  if (locations === undefined) {
    return undefined;
  }

  return locations.length === 0
    ? "The sandbox VM shares no project folder now."
    : `The sandbox VM shares ${locations.map((location) => printable(tildeForm(location, facts.home))).join(", ")} now.`;
};

export const DISCARD_CONFIRM = {
  title: "Discard your changes and leave? Nothing has been saved.",
  no: "No, back to review",
  yes: "Yes, leave",
};

export const WRITE_BACK_TITLE = "Copy settings changed in the sandbox back to your pi?";

export const WRITE_BACK_DETAIL =
  "When on, preference changes made inside the sandbox (the default model, the theme, extension settings) are copied to your pi on this Mac when a session starts and ends. Your pi wins when both changed.";

export const FIX_FOLDERS = "✖ Fix the project folder first.";

export const CANCELLED = "Cancelled. Nothing was changed.";

export const NOTHING_CHANGED = "Nothing changed.";

const STILL_RUNNING: Record<VmPhase, string> = {
  creating: "the VM may still be being created",
  stopping: "the VM may be stopped now, and the next pi starts it",
  starting: "the VM may still be starting",
  waiting: "the VM may still be starting",
};

const stoppedWaiting = (phase: VmPhase | undefined) => [
  `Stopped waiting. Your settings are saved; ${STILL_RUNNING[phase ?? "starting"]}.`,
  "Check it with pinata doctor, or run pinata init again.",
];

const VM_NOT_READY =
  "Your settings are saved, but the sandbox VM is not ready. Fix the problem above, then run pinata init again. pinata doctor checks everything.";

const STILL_BUSY: Record<VmPhase, string> = {
  creating: "The VM is still being created",
  stopping: "The VM is still stopping",
  starting: "The VM is still starting",
  waiting: "The VM is still starting",
};

export const vmInterruptWarning = (phase: VmPhase | undefined) =>
  `${STILL_BUSY[phase ?? "starting"]}. Press ctrl-c again to stop waiting; your settings are already saved.`;

export const stepTitle = (title: string, step: Step | undefined) =>
  step === undefined ? title : `${title}   step ${step.index} of ${step.count}`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const sizeText = (size: VmSpec) =>
  `${plural(size.cpus, "CPU", "CPUs")} · ${size.memoryGiB} GiB memory · ${size.diskGiB} GiB disk`;

const shown = (path: string, home: string) => printable(tildeForm(path, home));

const vmLine = (facts: HostFacts) => {
  if (facts.vm.state === "absent") {
    return "not created yet";
  }

  if (facts.vm.state === "unknown") {
    return `could not be checked: ${printable(facts.vm.reason)}`;
  }

  return `${facts.vm.state} · ${sizeText(facts.vm.size)}`;
};

const macLine = (facts: HostFacts) => {
  const disk = facts.freeDiskGiB === undefined ? "" : ` · ${facts.freeDiskGiB} GiB free disk`;

  return `${plural(facts.cpus, "CPU", "CPUs")} · ${facts.memoryGiB} GiB memory${disk}`;
};

export const introLines = (facts: HostFacts, firstRun: boolean, plain: boolean) => {
  const sessions = facts.sessions > 0 ? [sessionsRunning(facts.sessions)] : [];

  if (plain) {
    return [
      `This Mac: ${macLine(facts)}`,
      `Sandbox VM: ${vmLine(facts)}`,
      ...sessions.map((line) => `  ${line}`),
      "Nothing is saved until you choose Apply.",
      "",
    ];
  }

  const lead = firstRun
    ? "Sets up the sandbox pi runs in, in three short steps: the folders it may use, the size of its VM and the settings write-back. Nothing is saved until you choose Apply."
    : `Your settings are in ${shown(facts.configFile, facts.home)}. Change what you need, then choose Apply. Nothing is saved before that.`;

  return [
    { text: lead },
    "",
    { label: "This Mac     ", text: macLine(facts) },
    { label: "Sandbox VM   ", text: vmLine(facts) },
    ...sessions.map((line) => `             ${line}`),
    "",
  ];
};

const repoTag = (candidate: FolderCandidate, digits: number) => {
  if (candidate.repos === 0) {
    return "no git repository found";
  }

  const count = String(candidate.repos).padStart(digits);

  if (candidate.capped) {
    return `${count}+ git repositories`;
  }

  return candidate.repos === 1 ? `${count} git repository` : `${count} git repositories`;
};

const originTags = (candidate: FolderCandidate, digits: number) => {
  if (candidate.origin === "config") {
    return candidate.exists ? ["current"] : ["current", "missing, not shared until it exists"];
  }

  return candidate.origin === "env" ? ["from PINATA_ROOT"] : [repoTag(candidate, digits)];
};

export const folderTag = (candidate: FolderCandidate, candidates: FolderCandidate[], plain: boolean) => {
  const counts = candidates.filter((other) => other.repos > 0).map((other) => String(other.repos).length);
  const digits = plain ? 0 : Math.max(0, ...counts);

  return [...originTags(candidate, digits), ...(candidate.here ? ["you are here"] : [])].join(" · ");
};

export const rootSummary = (root: Answers["root"]) => (root === undefined ? "none" : printable(root));

const automaticSize = (facts: HostFacts) => existingVm(facts)?.size ?? facts.automatic;

export const shownSize = (vm: Answers["vm"], facts: HostFacts): VmSpec => {
  if (vm === "automatic") {
    return automaticSize(facts);
  }

  return "kept" in vm ? { ...automaticSize(facts), ...vm.kept } : vm;
};

const GROWN = "the VM's disk only grows";

const automaticParts = (facts: HostFacts) => {
  const size = automaticSize(facts);

  return {
    text: sizeText(size),
    grown: size.diskGiB > facts.automatic.diskGiB,
  };
};

export const automaticLabel = (facts: HostFacts) => {
  const { text, grown } = automaticParts(facts);

  return grown ? `${text} (${GROWN})` : text;
};

export const vmEditorDetail = (facts: HostFacts) =>
  `Every pi session runs in this VM. Automatic follows this Mac: CPUs from 2 to 8, half the memory from 4 to 10 GiB, and a ${facts.automatic.diskGiB} GiB disk.`;

const plainCollapsed = (vm: Answers["vm"], facts: HostFacts) => {
  if (vm !== "automatic") {
    return `Custom (${sizeText(shownSize(vm, facts))})`;
  }

  const { text, grown } = automaticParts(facts);

  return `Automatic (${grown ? `${text}; ${GROWN}` : text})`;
};

export const vmCollapsed = (vm: Answers["vm"], facts: HostFacts, plain: boolean) => {
  if (plain) {
    return plainCollapsed(vm, facts);
  }

  return vm === "automatic"
    ? `Automatic: ${automaticLabel(facts)}`
    : `Custom: ${sizeText(shownSize(vm, facts))}`;
};

export const numberFields = (facts: HostFacts, bounds: VmBounds) => {
  const disk = existingVm(facts)?.size.diskGiB;
  const free = facts.freeDiskGiB;

  return {
    cpus: {
      title: "CPUs for the VM",
      note: `this Mac has ${facts.cpus}`,
      step: 1,
      tooLow: `Choose ${bounds.cpus.min} to ${bounds.cpus.max} CPUs: this Mac has ${facts.cpus}.`,
      warn: () => undefined,
    },
    memoryGiB: {
      title: "Memory for the VM, in GiB",
      note: `this Mac has ${facts.memoryGiB} GiB`,
      step: 1,
      tooLow: `Choose ${bounds.memoryGiB.min} to ${bounds.memoryGiB.max} GiB: this Mac has ${facts.memoryGiB} GiB and macOS needs the rest.`,
      warn: (value: number) =>
        value > (facts.memoryGiB * 3) / 4
          ? "That leaves little memory for macOS. Press enter again to keep it."
          : undefined,
    },
    diskGiB: {
      title: "Disk for the VM, in GiB",
      note: free === undefined ? undefined : `${free} GiB free on this Mac`,
      hint: disk === undefined ? undefined : `the disk can only grow, it is ${disk} GiB now`,
      step: 10,
      tooLow:
        disk === undefined
          ? `Choose at least ${bounds.diskGiB.min} GiB.`
          : `The VM's disk is ${disk} GiB now and can only grow. Choose ${bounds.diskGiB.min} or more.`,
      tooHigh: `Choose at most ${bounds.diskGiB.max} GiB.`,
      warn: (value: number) =>
        free !== undefined && value > free + (disk ?? 0)
          ? `This Mac has ${free} GiB free. The disk file grows only as the VM fills it. Press enter again to keep it.`
          : undefined,
    },
  };
};

const partsText = (parts: VmPart[]) => {
  if (parts.length === 2) {
    return "size and folders";
  }

  return parts[0] === "size" ? "size" : "folders";
};

const afterExit = (sessions: number) => (sessions === 1 ? "after it exits" : "after they all exit");

const CREATE_TAIL =
  "this takes a minute or two, longer the first time while colima downloads the VM's system image";

export const vmActionText = (action: VmAction) => {
  if (action.kind === "create") {
    return `create the sandbox VM with this folder, pi's sessions folder and pinata's read-only state/vm folder; ${CREATE_TAIL}`;
  }

  if (action.kind === "restart") {
    return `restart the sandbox VM with the new ${partsText(action.parts)}; no pi session is running, and this usually takes under a minute`;
  }

  if (action.kind === "defer") {
    return `keep the sandbox VM as it is for now: ${sessionsRunning(action.sessions)}. The first pi you start ${afterExit(action.sessions)} restarts it with the new ${partsText(action.parts)}`;
  }

  if (action.kind === "on-next-start") {
    return `the sandbox VM is stopped; the next pi starts it with the new ${partsText(action.parts)}`;
  }

  if (action.kind === "unknown") {
    return `the sandbox VM could not be checked (${printable(action.reason)}); run pinata doctor after applying`;
  }

  return undefined;
};

const json = (value: unknown) => printable(JSON.stringify(value));

const automaticPart = (key: string, facts: HostFacts) => {
  const name = key.slice("vm.".length) as keyof VmSpec;
  const value = facts.automatic[name];

  return value === undefined ? "" : `   (back to automatic: ${value})`;
};

const keyedLines = (head: string, value: string, room: number) => {
  const line = `${head}   ${value}`;

  return widthOf(line) <= room ? [line] : [head, ...wrap(`    ${value}`, room)];
};

const richChangeLines = (change: Change, keyWidth: number, room: number, facts: HostFacts) => {
  const key = change.key.padEnd(keyWidth);
  const mark = { add: "+", change: "~", remove: "-" }[change.kind];
  const head = `${mark} ${key}`;

  if (change.kind === "add") {
    return keyedLines(head, json(change.after), room);
  }

  if (change.kind === "remove") {
    return keyedLines(head, `${json(change.before)}${automaticPart(change.key, facts)}`, room);
  }

  const line = `${head}   ${json(change.before)} → ${json(change.after)}`;

  if (widthOf(line) <= room) {
    return [line];
  }

  const arrow = `${" ".repeat(keyWidth + 5)}→ ${json(change.after)}`;
  const before = `${head}   ${json(change.before)}`;

  if (widthOf(before) <= room && widthOf(arrow) <= room) {
    return [before, arrow];
  }

  return [head, ...wrap(`    ${json(change.before)}`, room), ...wrap(`    → ${json(change.after)}`, room)];
};

const plainChangeLine = (change: Change) => {
  if (change.kind === "add") {
    return `added ${change.key}: ${json(change.after)}`;
  }

  if (change.kind === "remove") {
    return `removed ${change.key}`;
  }

  return `changed ${change.key}: ${json(change.before)} to ${json(change.after)}`;
};

const bullet = (text: string, room: number, plain: boolean) => {
  const mark = plain ? "- " : "• ";
  const [first = "", ...rest] = wrap(text, room - 4);

  return [`  ${mark}${first}`, ...rest.map((line) => `    ${line}`)];
};

const fileBullet = (plan: Plan, facts: HostFacts, existed: boolean) => {
  const verb = existed ? "change" : "create";
  const writeBackOnly =
    plan.vm.kind === "none" && plan.changes.every((change) => change.key.startsWith("writeBack."));

  return `${verb} ${shown(facts.configFile, facts.home)}${writeBackOnly ? " (applies from the next pi)" : ""}`;
};

export interface FileShape {
  existed: boolean;
  indent: string;
}

export const applyLines = (plan: Plan, facts: HostFacts, shape: FileShape, room: number, plain: boolean) => {
  const keyWidth = Math.max(0, ...plan.changes.map((change) => change.key.length));
  const diff = plan.changes.flatMap((change) =>
    plain ? [plainChangeLine(change)] : richChangeLines(change, keyWidth, room - 6, facts),
  );
  const reindent = plan.reindented
    ? [`(the rest of the file is kept; its indentation is normalised to ${indentText(shape.indent)})`]
    : [];
  const file =
    plan.changes.length === 0
      ? []
      : [
          ...bullet(fileBullet(plan, facts, shape.existed), room, plain),
          ...[...diff, ...reindent].flatMap((line) => wrap(`      ${line}`, room)),
        ];
  const vmText = vmActionText(plan.vm);
  const vm = vmText === undefined ? [] : bullet(vmText, room, plain);

  return ["When you apply:", ...file, ...vm];
};

const indentText = (indent: string) =>
  indent.startsWith("\t") ? "tabs" : plural(indent.length, "space", "spaces");

export const NOTHING_TO_DO =
  "Everything is set up: the file and the sandbox VM already match these settings.";

const hanging = (indent: string, text: string, room: number) => wrap(`${indent}${text}`, room);

const tagged = (head: string, tag: string, room: number) => {
  const gap = room - widthOf(head) - widthOf(tag);

  return gap >= 2 ? `${head}${" ".repeat(gap)}${tag}` : undefined;
};

const wideHead = (row: HubRow, room: number) =>
  tagged(`${row.label.padEnd(LABEL_WIDTH)}  ${row.value}`, row.tag, room);

const wideRowLines = (row: HubRow, room: number) => {
  const indent = " ".repeat(LABEL_WIDTH + 2);
  const problems = row.problems.flatMap((problem) => hanging(indent, printable(problem), room));

  return [wideHead(row, room) ?? "", ...problems];
};

const narrowRowLines = (row: HubRow, room: number) => {
  const head = tagged(row.label, row.tag, room);
  const value = hanging("  ", row.value, room);
  const problems = row.problems.flatMap((problem) => hanging("  ", printable(problem), room));

  return head === undefined
    ? [row.label, ...value, `  ${row.tag}`, ...problems]
    : [head, ...value, ...problems];
};

export const hubRowLines = (rows: HubRow[], room: number, plain: boolean) => {
  if (plain) {
    return rows.flatMap((row) => hanging("  ", `${row.label}: ${row.value} (${row.tag})`, room));
  }

  const wide = room >= HUB_TAGS_INLINE && rows.every((row) => wideHead(row, room) !== undefined);

  return rows.flatMap((row) => (wide ? wideRowLines(row, room) : narrowRowLines(row, room)));
};

const phaseText = (phase: VmPhase, parts: VmPart[]) => {
  if (phase === "creating") {
    return "Creating the VM…";
  }

  if (phase === "stopping") {
    return "Stopping the VM…";
  }

  return phase === "starting"
    ? `Starting the VM with the new ${partsText(parts)}…`
    : "Waiting for the VM's engine…";
};

export const progressText = (phase: VmPhase, action: VmAction) =>
  phaseText(phase, action.kind === "restart" ? action.parts : ["size", "folders"]);

const deferredLines = (sessions: number, parts: VmPart[]) => [
  `▲ Kept as it is: ${sessionsRunning(sessions)}. The first pi you start ${afterExit(sessions)} restarts it with the new ${partsText(parts)}.`,
];

const STOPPED_VM = "The VM is stopped; the next pi starts it with these settings.";

const STARTED_MEANWHILE =
  "▲ Kept as it is: a pi session started meanwhile. The first pi you start after it exits restarts the VM with the new settings.";

const vmDoneLine = (applied: VmApplied, action: VmAction, elapsed: string, plain: boolean) => {
  const mark = plain ? "" : "✔ ";
  const what = plain ? " the VM" : "";

  if (applied === "created" && action.kind === "create") {
    return `${mark}Created${what} in ${elapsed}: ${sizeText(action.size)}`;
  }

  if (applied === "restarted" && action.kind === "restart") {
    return `${mark}Restarted${what} in ${elapsed} with the new ${partsText(action.parts)}`;
  }

  if (applied === "stopped") {
    return STOPPED_VM;
  }

  if (typeof applied === "object") {
    return STARTED_MEANWHILE;
  }

  return `${mark}Nothing to do: the VM already matches`;
};

const vmUnknownLine = (reason: string) =>
  `▲ The VM could not be checked (${printable(reason)}). Run pinata doctor to see why.`;

const verbOf = (action: VmAction) => (action.kind === "create" ? "create" : "restart");

const vmFailureLines = (action: VmAction, elapsed: string, message: string) => {
  const last = message.trim().split("\n").at(-1) ?? "";

  return [`✖ Could not ${verbOf(action)} the VM after ${elapsed}.`, `  ${printable(last)}`];
};

export const VM_FAILURE_CHOICES = { retry: "Try again", exit: "Exit; your settings stay saved" };

const savedLine = (facts: HostFacts, plain: boolean) =>
  `${plain ? "" : "✔ "}Saved ${shown(facts.configFile, facts.home)}`;

const saveFailedLine = (file: string, home: string, reason: string) =>
  `✖ Could not save ${shown(file, home)}: ${printable(reason)}`;

const nextCommand = (root: Answers["root"], facts: HostFacts) => {
  const latest = facts.candidates.find((candidate) => candidate.stored === root)?.latestRepo;

  if (latest !== undefined) {
    return `cd ${shown(latest, facts.home)} && pi`;
  }

  return `cd <a project in ${printable(root ?? "~")}> && pi`;
};

const successLines = (root: Answers["root"], facts: HostFacts, vmReady: boolean, plain: boolean) => {
  const head = vmReady ? "Done. The sandbox is ready." : "Done. Settings saved.";
  const rows: Array<[string, string]> = [
    ["Next", nextCommand(root, facts)],
    ["Change", "pinata init"],
    ["Check", "pinata doctor"],
    ["Settings", shown(facts.configFile, facts.home)],
  ];

  if (plain) {
    return [head, ...rows.map(([label, value]) => `${label}: ${value}`)];
  }

  return [
    head,
    "",
    ...rows.map(([label, value]) => ({ label: label.padEnd(10), text: value })),
    { label: " ".repeat(10), text: `every key: ${shown(facts.docsFile, facts.home)}` },
  ];
};

const NOTHING_WAS_CHANGED = "Nothing was changed.";

type InvalidRead = Extract<DocumentRead, { ok: false }>;

export const invalidText = (read: InvalidRead) =>
  read.kind === "json"
    ? {
        problem: "is not valid JSON",
        fix: "fix the file, or move it away to start over, then run pinata init again",
      }
    : {
        problem: "has a problem this setup does not fix",
        fix: read.hint ?? "fix that key, then run pinata init again",
      };

export const invalidLines = (read: InvalidRead, file: string, home: string) => {
  const { problem, fix } = invalidText(read);

  return {
    lines: [`✖ ${shown(file, home)} ${problem}:`, { text: printable(read.message), indent: "  " }],
    end: `${NOTHING_WAS_CHANGED} ${fix[0]?.toUpperCase()}${fix.slice(1)}.`,
  };
};

export const eventLines = (event: ApplyEvent, facts: HostFacts, plain: boolean): Paragraph[] => {
  switch (event.kind) {
    case "nothing-to-do":
      return [NOTHING_TO_DO];
    case "saved":
      return [savedLine(facts, plain)];
    case "save-failed":
      return [saveFailedLine(facts.configFile, facts.home, event.reason)];
    case "nothing-changed":
      return [NOTHING_WAS_CHANGED];
    case "vm-unknown":
      return [vmUnknownLine(event.reason)];
    case "vm-stopped":
      return [STOPPED_VM];
    case "vm-deferred":
      return deferredLines(event.sessions, event.parts);
    case "vm-done":
      return [vmDoneLine(event.applied, event.action, event.elapsed, plain)];
    case "vm-failed":
      return vmFailureLines(event.action, event.elapsed, event.reason);
    case "vm-not-ready":
      return [VM_NOT_READY];
    case "vm-cancelled":
      return stoppedWaiting(event.phase);
    case "done":
      return successLines(event.root, facts, event.vmReady, plain);
  }
};

export type Paragraph = string | { text: string; indent?: string } | { label: string; text: string };

const labelled = (label: string, text: string, room: number) =>
  wrap(`${" ".repeat(label.length)}${text}`, room).map((line, index) =>
    index === 0 ? `${label}${line.slice(label.length)}` : line,
  );

export const wrapped = (paragraphs: Paragraph[], room: number) =>
  paragraphs.flatMap((paragraph) => {
    if (typeof paragraph === "string") {
      return paragraph === "" ? [""] : wrap(paragraph, room);
    }

    if ("label" in paragraph) {
      return labelled(paragraph.label, paragraph.text, room);
    }

    const indent = paragraph.indent ?? "";

    return wrap(paragraph.text, room - indent.length).map((line) => `${indent}${line}`);
  });
