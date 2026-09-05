/**
 * Table speech strategies for audio-first document reading.
 *
 * Deterministic PRODUCT-SIDE speech strategy for tables.
 * Do not modify frozen Listen 1.1.0 research semantics.
 *
 * Strategy:
 * - Simple (2 columns): "Header: value. Header: value."
 * - Complex (3+ columns): "Row 1. A: x. B: y. C: z."
 * - Never summarize, drop cells, or reorder semantic relationships
 * - Provide literal fallback
 */
import type { DocumentBlock } from "@/domain/documents/types";

export interface TableCell {
  text: string;
  columnIndex: number;
  rowIndex: number;
}

export interface TableStructure {
  columns: string[];
  rows: TableCell[][];
  columnCount: number;
  rowCount: number;
}

/**
 * Parse a table from document blocks.
 * Tables in the document model are represented as consecutive table-cell blocks.
 * Uses block level for column index and sequential counting for row index.
 */
export function parseTableFromBlocks(
  blocks: DocumentBlock[],
  startIndex: number,
): { table: TableStructure; endIndex: number } | null {
  const cells: TableCell[] = [];
  let endIndex = startIndex;

  // Collect all consecutive table-cell blocks
  while (endIndex < blocks.length && blocks[endIndex].type === "table-cell") {
    const block = blocks[endIndex];
    const text = block.text.trim();
    if (text) {
      cells.push({
        text,
        columnIndex: block.level ?? 0,
        rowIndex: 0, // Will be computed after collection
      });
    }
    endIndex++;
  }

  if (cells.length === 0) return null;

  // Determine column count from max level + 1
  const maxCol = Math.max(...cells.map((c) => c.columnIndex));
  const columnCount = maxCol + 1;

  // Compute row indices based on column position
  // Cells cycle through columns: 0,1,2,0,1,2,...
  // So rowIndex = Math.floor(cellIndex / columnCount)
  for (let i = 0; i < cells.length; i++) {
    cells[i].rowIndex = Math.floor(i / columnCount);
  }

  // Group cells by row
  const rows: TableCell[][] = [];
  for (let r = 0; r < Math.ceil(cells.length / columnCount); r++) {
    const rowCells = cells
      .filter((c) => c.rowIndex === r)
      .sort((a, b) => a.columnIndex - b.columnIndex);
    if (rowCells.length > 0) {
      rows.push(rowCells);
    }
  }

  if (rows.length === 0) return null;

  // First row is header
  const columns = rows[0].map((c) => c.text);

  return {
    table: {
      columns,
      rows: rows.slice(1), // Data rows (excluding header)
      columnCount,
      rowCount: rows.length,
    },
    endIndex,
  };
}

/**
 * Generate spoken text for a 2-column table.
 * Format: "Header: value. Header: value."
 * This preserves the column/value relationship explicitly.
 */
export function speakSimpleTable(table: TableStructure): string {
  if (table.columnCount === 0 || table.rowCount === 0) return "";
  if (table.rows.length === 0) return "";

  const parts: string[] = [];

  for (const row of table.rows) {
    const rowParts: string[] = [];
    for (let i = 0; i < row.length && i < table.columns.length; i++) {
      const header = table.columns[i] ?? `Column ${i + 1}`;
      rowParts.push(`${header}: ${row[i].text}`);
    }
    if (rowParts.length > 0) {
      parts.push(rowParts.join(". "));
    }
  }

  return parts.join(". ");
}

/**
 * Generate spoken text for a complex table (3+ columns).
 * Format: "Row 1. A: x. B: y. C: z."
 */
export function speakComplexTable(table: TableStructure): string {
  if (table.columnCount === 0 || table.rowCount === 0) return "";
  if (table.rows.length === 0) return "";

  const parts: string[] = [];

  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r];
    const rowParts: string[] = [];
    for (let i = 0; i < row.length && i < table.columns.length; i++) {
      const header = table.columns[i] ?? `Column ${i + 1}`;
      rowParts.push(`${header}: ${row[i].text}`);
    }
    if (rowParts.length > 0) {
      parts.push(`Row ${r + 1}. ${rowParts.join(". ")}`);
    }
  }

  return parts.join(". ");
}

/**
 * Determine if a table should be spoken as simple or complex.
 * Simple: 2 columns (header:value pairs are clear)
 * Complex: 3+ columns (need row enumeration)
 */
export function isSimpleTable(table: TableStructure): boolean {
  return table.columnCount <= 2;
}

/**
 * Generate spoken text for a table, choosing the appropriate strategy.
 */
export function speakTable(table: TableStructure): string {
  if (table.rows.length === 0) return "";
  if (isSimpleTable(table)) {
    return speakSimpleTable(table);
  }
  return speakComplexTable(table);
}
