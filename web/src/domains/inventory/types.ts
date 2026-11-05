// 결과 화면 데이터 (API GET /runs/{id}/view, domains/inventory/view.py)
export interface CellRow {
  item_id: string; week: number; branch: string; model: string;
  arrivals: number; on_hand: number; on_order: number; order: number;
  demand: number; sales: number; lost: number; end_stock: number;
}

export interface PairRow {
  branch: string; model: string; demand: number; lost: number; stockout_rate: number; avg_stock_days: number;
}

export interface PlanRow {
  item_id: string; week: number; branch: string; model: string;
  forecast: number; on_hand: number; on_order: number; target: number; need: number; order: number; short: number;
  amount: number; status: string; evidence: string; constraint: string;
}

export interface InventoryView {
  weeks: number;
  branches: Record<string, string>;
  models: Record<string, { name: string; family: string; maker: string; phase: string; unit_cost: number; eol_week: number | null }>;
  cells: CellRow[];
  pairs: PairRow[];
  plan: PlanRow[];
}
