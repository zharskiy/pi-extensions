import type { TranscriptItem } from "../types/view.ts";
import { createFileReader, type LinkRead, linkKey, walkLineage } from "./lineage-walk.ts";
import { readSessionTree, sessionPath } from "./session-file.ts";

export const LINEAGE_TYPE = "pi-adapter:lineage";

export const LEGACY_LINEAGE_TYPE = "pi-adapter:previous-session";

type LineageReason = "handoff" | "compaction";

export type LineageEntry = { file: string; leafId: string | null; reason: LineageReason };

export type LineageLinkRead = { link: LineageEntry; read: LinkRead<TranscriptItem[]> };

export type LineageRead = { links: LineageLinkRead[]; truncated: boolean };

type LinkPath = { items: TranscriptItem[]; previous?: LineageEntry };

export const lineageEntryOf = (customType: string | undefined, data: unknown): LineageEntry | undefined => {
  if (customType !== LINEAGE_TYPE && customType !== LEGACY_LINEAGE_TYPE) {
    return undefined;
  }

  const fields = data as Partial<Record<keyof LineageEntry, unknown>> | undefined;

  if (typeof fields?.file !== "string") {
    return undefined;
  }

  const leafId = typeof fields.leafId === "string" ? fields.leafId : null;
  const reason = fields.reason === "compaction" ? "compaction" : "handoff";

  return { file: fields.file, leafId, reason };
};

export const createLineageReader = () => {
  const readTree = createFileReader(readSessionTree);

  const readLink = (link: LineageEntry): LinkRead<LinkPath> => {
    const tree = readTree(link.file);

    if (tree.status !== "read") {
      return tree;
    }

    const path = sessionPath(tree.value, link.leafId);

    const previous = path.customEntries
      .map((entry) => lineageEntryOf(entry.customType, entry.data))
      .filter((entry): entry is LineageEntry => entry?.reason === "handoff")
      .at(-1);

    return { status: "read", value: { items: path.items, previous } };
  };

  const previousOf = (link: LineageEntry) => {
    const read = readLink(link);

    return read.status === "read" ? read.value.previous : undefined;
  };

  return (start: LineageEntry): LineageRead => {
    const walk = walkLineage(start, previousOf, { key: linkKey });

    const links = walk.links.map((link): LineageLinkRead => {
      const read = readLink(link);

      return { link, read: read.status === "read" ? { status: "read", value: read.value.items } : read };
    });

    return { links, truncated: walk.truncated };
  };
};
