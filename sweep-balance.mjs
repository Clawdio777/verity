// Reads the USDC balance out of `acp wallet balance` output.
// The CLI's columns have changed twice (a NETWORK column was added, then removed again by 22/10/2026),
// so columns are found by their header names, not by position. Rows are matched on the real USDC
// contract, never the symbol: the wallet holds look-alike "USDC" spam tokens.
export function findTokenBalance(out, contract) {
  const rows = out.split("\n").map(l => l.split("\t").map(c => c.trim()));
  const header = rows.find(r => r.includes("CONTRACT") && r.includes("BALANCE"));
  if (!header) return null;
  const ci = header.indexOf("CONTRACT"), bi = header.indexOf("BALANCE");
  const row = rows.find(r => r !== header && (r[ci] || "").toLowerCase() === contract.toLowerCase());
  return row ? parseFloat(row[bi]) : null;
}
