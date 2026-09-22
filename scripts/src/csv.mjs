// Minimal RFC-4180 CSV reader shared by the canonical import pipeline.
// Handles quoted fields, doubled quotes, embedded commas/newlines, and CRLF.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawContent = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawContent = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (sawContent || row.some((value) => value !== "")) rows.push(row);
      row = [];
      sawContent = false;
    } else {
      field += ch;
      sawContent = true;
    }
  }
  if (field !== "" || row.length > 0 || sawContent) {
    row.push(field);
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

export function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("CSV is empty: expected a header row");
  }
  const header = rows[0];
  const seen = new Set();
  for (const name of header) {
    if (seen.has(name)) {
      throw new Error(`CSV header has duplicate column: ${name}`);
    }
    seen.add(name);
  }
  return {
    header,
    records: rows.slice(1).map((row) => {
      if (row.length !== header.length) {
        throw new Error(
          `CSV row has ${row.length} fields, expected ${header.length}: ${JSON.stringify(row.slice(0, 3))}...`,
        );
      }
      return Object.fromEntries(header.map((name, index) => [name, row[index]]));
    }),
  };
}
