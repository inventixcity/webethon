export function boundedRows<T>(rows: T[], maximum = 2000) {
  return { rows: rows.slice(0, maximum), truncated: rows.length > maximum };
}
