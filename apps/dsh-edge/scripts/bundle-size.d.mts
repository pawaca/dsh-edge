export const WORKER_SIZE_LIMIT_BYTES: number
export function parseWranglerUploadSizes(output: string): { bytes: number, gzipBytes: number }
export function requireWorkerSizeLimit(output: string, maxBytes?: number): { bytes: number, gzipBytes: number }
