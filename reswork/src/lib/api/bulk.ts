// Feature API: bulk upload + indexing.
// Thin delegates over lib/wb/bulkIngest; behavior lives there.
import {
  assessQuota,
  confirmBulkFiles,
  previewBulkFiles,
  readWorkspaceUsage,
  MAX_BULK_FILES,
  WORKSPACE_STORAGE_QUOTA_BYTES,
} from "../wb/bulkIngest";
import { readInference } from "./inference";

export const bulkApi = {
  maxBulkFiles: () => MAX_BULK_FILES,
  quotaBytes: () => WORKSPACE_STORAGE_QUOTA_BYTES,
  previewBulk: (files: readonly File[], onProgress?: (done: number, total: number) => void) =>
    previewBulkFiles(files, undefined, onProgress),
  workspaceUsage: () => readWorkspaceUsage(),
  assessQuota: (
    usedBytes: number,
    batchBytes: number,
    quotaBytes: number = WORKSPACE_STORAGE_QUOTA_BYTES,
  ) => assessQuota(usedBytes, batchBytes, quotaBytes),
  confirmBulk: (
    items: Parameters<typeof confirmBulkFiles>[0],
    onProgress?: (done: number, total: number) => void,
  ) => confirmBulkFiles(items, { embedMode: readInference().embedMode, onProgress }),
};
