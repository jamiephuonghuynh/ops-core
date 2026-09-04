declare module "xlsx" {
  export interface WorkSheet { [key: string]: unknown }
  export interface WorkBook { SheetNames: string[]; Sheets: Record<string, WorkSheet> }
  export function read(data: Uint8Array | ArrayBuffer, options?: Record<string, unknown>): WorkBook;
  export const utils: {
    sheet_to_json<T = unknown[]>(worksheet: WorkSheet, options?: Record<string, unknown>): T[];
  };
}
