import { getPath } from "../../config/index.ts";
import { isInSection, SECTIONS, WRITE_BACK_PATH } from "./document.ts";
import { isPlanEmpty, ownedProblems } from "./plan.ts";
import {
  applyLines,
  HUB_SUMMARY_TITLE,
  type HubRow,
  hubRowLines,
  NOTHING_TO_DO,
  OTHER_SETTINGS,
  rootsSummary,
  shownSize,
  sizeText,
  type Tag,
  wrapped,
} from "./screens.ts";
import type { Answers, ConfigDocument, HostFacts, OwnedProblem, Plan, Section, VmAction } from "./types.ts";

export interface ReviewState {
  answers: Answers;
  touched: ReadonlySet<Section>;
}

export interface ReviewView {
  plain: boolean;
  table: boolean;
  notice?: string;
}

export const SECTION_LABELS: Record<Section, string> = {
  folders: "Project folders",
  vm: "VM size",
  writeBack: "Settings write-back",
};

const keepsSize = (vm: VmAction) => ("parts" in vm ? !vm.parts.includes("size") : vm.kind === "none");

export const createReview = (document: ConfigDocument, facts: HostFacts, env: NodeJS.ProcessEnv) => {
  const problems = ownedProblems(document, { home: facts.home, env });

  const sectionProblems = (section: Section, state: ReviewState, plan: Plan): OwnedProblem[] => {
    const owned = state.touched.has(section)
      ? []
      : problems.filter((problem) => isInSection(section, problem.key));
    const planned =
      section === "folders" ? plan.problems.map((message) => ({ key: "workspaceRoots", message })) : [];

    return [...owned, ...planned];
  };

  const tagOf = (section: Section, state: ReviewState, plan: Plan): Tag => {
    const touched = state.touched.has(section);

    if (sectionProblems(section, state, plan).length > 0) {
      return "invalid";
    }

    if (section === "vm" && state.answers.vm === "automatic") {
      return "automatic";
    }

    if (section === "writeBack" && getPath(plan.next, WRITE_BACK_PATH) === undefined) {
      return "default";
    }

    const changes = plan.changes.filter((change) => isInSection(section, change.key));

    if (changes.length === 0 && touched) {
      return "chosen";
    }

    if (changes.length === 0) {
      return section === "vm" && !keepsSize(plan.vm) ? "from the file" : "current";
    }

    return touched && changes.every((change) => change.kind === "add") ? "chosen" : "changed";
  };

  const sectionValue = (section: Section, answers: Answers) => {
    if (section === "folders") {
      return rootsSummary(answers.roots);
    }

    return section === "vm" ? sizeText(shownSize(answers.vm, facts)) : answers.writeBack ? "on" : "off";
  };

  const rowsOf = (state: ReviewState, plan: Plan): HubRow[] =>
    SECTIONS.map((section) => ({
      label: SECTION_LABELS[section],
      value: sectionValue(section, state.answers),
      tag: tagOf(section, state, plan),
      problems: sectionProblems(section, state, plan).map((problem) => problem.message),
    }));

  const lines = (state: ReviewState, plan: Plan, view: ReviewView) => (room: number) => {
    const done = isPlanEmpty(plan) && plan.problems.length === 0;
    const shape = { existed: document.text !== undefined, indent: document.indent };
    const effect = done ? wrapped([NOTHING_TO_DO], room) : applyLines(plan, facts, shape, room, view.plain);
    const rows = view.table || view.plain ? hubRowLines(rowsOf(state, plan), room, view.plain) : [];
    const framed = view.table && !view.plain;

    return [
      ...(framed ? [HUB_SUMMARY_TITLE] : []),
      ...rows,
      ...(framed ? [""] : []),
      ...(plan.notices.length === 0 ? [] : [...wrapped(plan.notices, room), ""]),
      ...(view.notice === undefined ? [] : [...wrapped([view.notice], room), ""]),
      ...effect,
      ...(view.plain ? [] : ["", ...wrapped([OTHER_SETTINGS], room), ""]),
    ];
  };

  return { lines };
};
