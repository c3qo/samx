import type { LinkRecord, LinkRecordSet } from "@c3qo/samx-schemas";
import { linkRecordSetSchema } from "@c3qo/samx-schemas";

import { atomicWriteJson, readJsonFile } from "../store/atomic.js";
import { samxPaths } from "../store/paths.js";

export interface LinkRecordsOptions {
  samxHome?: string;
}

export async function readLinkRecords(options: LinkRecordsOptions = {}): Promise<LinkRecordSet> {
  const records = await readJsonFile(samxPaths(options.samxHome).linkRecords, { links: [] });
  return linkRecordSetSchema.parse(records);
}

export async function upsertLinkRecord(
  options: LinkRecordsOptions,
  record: LinkRecord
): Promise<LinkRecordSet> {
  const records = await readLinkRecords(options);
  const links = records.links.filter((link) => link.id !== record.id);
  const updated = linkRecordSetSchema.parse({ links: [...links, record] });
  await atomicWriteJson(samxPaths(options.samxHome).linkRecords, updated);
  return updated;
}

export async function removeLinkRecord(
  options: LinkRecordsOptions,
  id: string
): Promise<LinkRecordSet> {
  const records = await readLinkRecords(options);
  const updated = linkRecordSetSchema.parse({
    links: records.links.filter((link) => link.id !== id),
  });
  await atomicWriteJson(samxPaths(options.samxHome).linkRecords, updated);
  return updated;
}
