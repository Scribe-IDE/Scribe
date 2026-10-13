// Shapes shared with the Rust backend and across modules.


export interface CompileResult {
  ok: boolean;
  engine: string;
  log: string;
  pdf: string | null;
}

export interface NotebookCell {
  cell_type: string;
  source: string;
  figure_id: string | null;
  /** The original .ipynb cell, kept so saving preserves its outputs and metadata. */
  raw?: IpynbCell;
}

export interface IpynbCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, any>;
  outputs?: unknown[];
  execution_count?: number | null;
  id?: string;
}

export interface IpynbDoc {
  cells: IpynbCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export interface NotebookInfo {
  cells: NotebookCell[];
  figure_ids: string[];
  /** Names the notebook exports with nbval()/nbtable(). */
  value_names: string[];
  /** Figure ids, plus "values", whose output is older than the notebook. */
  stale: string[];
}

export interface RunResult {
  ok: boolean;
  log: string;
  figures: string[];
}

export interface CellResult { id: string; ok: boolean; stdout: string; stderr: string; figures: string[]; }
