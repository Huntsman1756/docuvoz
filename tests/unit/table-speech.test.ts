import { describe, it, expect } from "vitest";
import {
  speakSimpleTable,
  speakComplexTable,
  speakTable,
  isSimpleTable,
  parseTableFromBlocks,
  type TableStructure,
} from "@/domain/spoken/table-speech";
import type { DocumentBlock } from "@/domain/documents/types";

describe("table-speech", () => {
  describe("speakSimpleTable", () => {
    it("speaks a 2-column table with explicit header:value pairs", () => {
      const table: TableStructure = {
        columns: ["Year", "Interest rate"],
        rows: [
          [
            { text: "2024", columnIndex: 0, rowIndex: 0 },
            { text: "3.5%", columnIndex: 1, rowIndex: 0 },
          ],
          [
            { text: "2025", columnIndex: 0, rowIndex: 1 },
            { text: "2.9%", columnIndex: 1, rowIndex: 1 },
          ],
        ],
        columnCount: 2,
        rowCount: 3,
      };

      const result = speakSimpleTable(table);
      expect(result).toBe(
        "Year: 2024. Interest rate: 3.5%. Year: 2025. Interest rate: 2.9%",
      );
    });

    it("handles empty table", () => {
      const table: TableStructure = {
        columns: [],
        rows: [],
        columnCount: 0,
        rowCount: 0,
      };

      expect(speakSimpleTable(table)).toBe("");
    });

    it("preserves column/value relationship", () => {
      const table: TableStructure = {
        columns: ["Name", "Value"],
        rows: [
          [
            { text: "Alice", columnIndex: 0, rowIndex: 0 },
            { text: "100", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakSimpleTable(table);
      expect(result).toBe("Name: Alice. Value: 100");
    });
  });

  describe("speakComplexTable", () => {
    it("speaks a complex table with row enumeration", () => {
      const table: TableStructure = {
        columns: ["Country", "GDP", "Population"],
        rows: [
          [
            { text: "USA", columnIndex: 0, rowIndex: 0 },
            { text: "25.5T", columnIndex: 1, rowIndex: 0 },
            { text: "331M", columnIndex: 2, rowIndex: 0 },
          ],
          [
            { text: "China", columnIndex: 0, rowIndex: 1 },
            { text: "18.3T", columnIndex: 1, rowIndex: 1 },
            { text: "1.4B", columnIndex: 2, rowIndex: 1 },
          ],
        ],
        columnCount: 3,
        rowCount: 3,
      };

      const result = speakComplexTable(table);
      expect(result).toBe(
        "Row 1. Country: USA. GDP: 25.5T. Population: 331M. Row 2. Country: China. GDP: 18.3T. Population: 1.4B",
      );
    });
  });

  describe("isSimpleTable", () => {
    it("identifies simple tables (≤2 columns)", () => {
      const simple: TableStructure = {
        columns: ["A", "B"],
        rows: [],
        columnCount: 2,
        rowCount: 100,
      };
      expect(isSimpleTable(simple)).toBe(true);
    });

    it("identifies complex tables (3+ columns)", () => {
      const complex: TableStructure = {
        columns: ["A", "B", "C"],
        rows: [],
        columnCount: 3,
        rowCount: 2,
      };
      expect(isSimpleTable(complex)).toBe(false);
    });
  });

  describe("speakTable", () => {
    it("chooses simple strategy for 2-column table", () => {
      const table: TableStructure = {
        columns: ["Key", "Value"],
        rows: [
          [
            { text: "Name", columnIndex: 0, rowIndex: 0 },
            { text: "Test", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("Key: Name. Value: Test");
    });

    it("chooses complex strategy for 3-column table", () => {
      const table: TableStructure = {
        columns: ["A", "B", "C"],
        rows: [
          [
            { text: "1", columnIndex: 0, rowIndex: 0 },
            { text: "2", columnIndex: 1, rowIndex: 0 },
            { text: "3", columnIndex: 2, rowIndex: 0 },
          ],
        ],
        columnCount: 3,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toContain("Row 1.");
    });
  });

  describe("parseTableFromBlocks", () => {
    it("parses consecutive table-cell blocks with correct row/column assignment", () => {
      // 2x2 table: 4 cells, columnCount=2
      const blocks: DocumentBlock[] = [
        { id: "b1", type: "table-cell", text: "Name", page: 1, order: 0, level: 0 },
        { id: "b2", type: "table-cell", text: "Value", page: 1, order: 1, level: 1 },
        { id: "b3", type: "table-cell", text: "Test", page: 1, order: 2, level: 0 },
        { id: "b4", type: "table-cell", text: "123", page: 1, order: 3, level: 1 },
        { id: "b5", type: "paragraph", text: "Not a table", page: 1, order: 4 },
      ];

      const result = parseTableFromBlocks(blocks, 0);
      expect(result).not.toBeNull();
      expect(result?.endIndex).toBe(4); // Index of first non-table block
      expect(result?.table.columnCount).toBe(2);
      expect(result?.table.rowCount).toBe(2); // header + 1 data row (4 cells / 2 cols = 2 rows)
      expect(result?.table.columns).toEqual(["Name", "Value"]);
      expect(result?.table.rows).toHaveLength(1);
    });

    it("returns null for non-table blocks", () => {
      const blocks: DocumentBlock[] = [
        { id: "b1", type: "paragraph", text: "Not a table", page: 1, order: 0 },
      ];

      expect(parseTableFromBlocks(blocks, 0)).toBeNull();
    });

    it("handles header + one row", () => {
      const blocks: DocumentBlock[] = [
        { id: "b1", type: "table-cell", text: "A", page: 1, order: 0, level: 0 },
        { id: "b2", type: "table-cell", text: "B", page: 1, order: 1, level: 1 },
        { id: "b3", type: "table-cell", text: "1", page: 1, order: 2, level: 0 },
        { id: "b4", type: "table-cell", text: "2", page: 1, order: 3, level: 1 },
      ];

      const result = parseTableFromBlocks(blocks, 0);
      expect(result).not.toBeNull();
      expect(result?.table.rows).toHaveLength(1);
      expect(result?.table.columns).toEqual(["A", "B"]);
    });

    it("handles 3+ columns", () => {
      const blocks: DocumentBlock[] = [
        { id: "b1", type: "table-cell", text: "X", page: 1, order: 0, level: 0 },
        { id: "b2", type: "table-cell", text: "Y", page: 1, order: 1, level: 1 },
        { id: "b3", type: "table-cell", text: "Z", page: 1, order: 2, level: 2 },
        { id: "b4", type: "table-cell", text: "1", page: 1, order: 3, level: 0 },
        { id: "b5", type: "table-cell", text: "2", page: 1, order: 4, level: 1 },
        { id: "b6", type: "table-cell", text: "3", page: 1, order: 5, level: 2 },
      ];

      const result = parseTableFromBlocks(blocks, 0);
      expect(result).not.toBeNull();
      expect(result?.table.columnCount).toBe(3);
      expect(result?.table.columns).toEqual(["X", "Y", "Z"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty cells", () => {
      const table: TableStructure = {
        columns: ["A", "B"],
        rows: [
          [
            { text: "1", columnIndex: 0, rowIndex: 0 },
            { text: "", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("A: 1. B: ");
    });

    it("handles numeric values", () => {
      const table: TableStructure = {
        columns: ["Item", "Count"],
        rows: [
          [
            { text: "Widgets", columnIndex: 0, rowIndex: 0 },
            { text: "1,234", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("Item: Widgets. Count: 1,234");
    });

    it("handles percentages", () => {
      const table: TableStructure = {
        columns: ["Rate", "Value"],
        rows: [
          [
            { text: "Tax", columnIndex: 0, rowIndex: 0 },
            { text: "21%", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("Rate: Tax. Value: 21%");
    });

    it("handles currency", () => {
      const table: TableStructure = {
        columns: ["Item", "Price"],
        rows: [
          [
            { text: "Book", columnIndex: 0, rowIndex: 0 },
            { text: "$29.99", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("Item: Book. Price: $29.99");
    });

    it("handles legal references", () => {
      const table: TableStructure = {
        columns: ["Article", "Content"],
        rows: [
          [
            { text: "Art. 1", columnIndex: 0, rowIndex: 0 },
            { text: "Lorem ipsum", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("Article: Art. 1. Content: Lorem ipsum");
    });

    it("handles 10+ rows", () => {
      const rows: TableStructure["rows"] = [];
      for (let i = 0; i < 15; i++) {
        rows.push([
          { text: `Item ${i}`, columnIndex: 0, rowIndex: i },
          { text: `${i * 10}`, columnIndex: 1, rowIndex: i },
        ]);
      }
      const table: TableStructure = {
        columns: ["Item", "Value"],
        rows,
        columnCount: 2,
        rowCount: 16,
      };

      const result = speakTable(table);
      expect(result).toContain("Item: Item 0. Value: 0");
      expect(result).toContain("Item: Item 14. Value: 140");
    });

    it("handles unicode", () => {
      const table: TableStructure = {
        columns: ["Nombre", "Valor"],
        rows: [
          [
            { text: "Año", columnIndex: 0, rowIndex: 0 },
            { text: "2024", columnIndex: 1, rowIndex: 0 },
          ],
        ],
        columnCount: 2,
        rowCount: 2,
      };

      const result = speakTable(table);
      expect(result).toBe("Nombre: Año. Valor: 2024");
    });
  });
});
