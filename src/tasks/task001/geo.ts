export type StandardRow = Record<string, unknown>;

export interface SalesAreaIndex {
  byProvince: Record<string, StandardRow>;
  byProvinceOld: Record<string, StandardRow>;
  byProvinceWard: Record<string, StandardRow>;
}

export function normalize(value: unknown): string {
  return String(value == null ? "" : value).trim();
}

export function geoKey(value: unknown): string {
  let text = normalize(value).toLowerCase();
  if (!text) return "";
  text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  text = text.replace(/đ/g, "d");
  text = text.replace(/\b(tinh|thanh pho|tp|city|province)\b/g, " ");
  return text.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeProvinceText(value: unknown): string {
  let text = normalize(value);
  if (!text) return "";
  text = text.replace(/^[,\s]+|[,\s]+$/g, "");
  text = text.replace(/^(tinh|tỉnh|thanh pho|thành phố|tp\.?|tp|city|province)\s+/i, "");
  text = text.replace(/\s+/g, " ").trim();
  const key = geoKey(text);
  if (["hcm", "tphcm", "tp hcm", "hochiminh", "hochiminhcity", "saigon"].includes(key)) return "Hồ Chí Minh";
  if (key === "hanoi" || key === "ha noi") return "Hà Nội";
  if (key === "danang" || key === "da nang") return "Đà Nẵng";
  return text;
}

export function buildSalesAreaIndex(rows: StandardRow[]): SalesAreaIndex {
  const byProvince: Record<string, StandardRow> = {};
  const byProvinceOld: Record<string, StandardRow> = {};
  const byProvinceWard: Record<string, StandardRow> = {};
  for (const row of rows) {
    const province = normalizeProvinceText(row.province_standard);
    const provinceOld = normalizeProvinceText(row.province_standard_old);
    const wardKey = geoKey(row.ward_standard);
    const pKey = geoKey(province);
    const oldKey = geoKey(provinceOld);
    if (pKey && !byProvince[pKey]) byProvince[pKey] = row;
    if (oldKey && !byProvinceOld[oldKey]) byProvinceOld[oldKey] = row;
    if (pKey && wardKey && !byProvinceWard[`${pKey}|${wardKey}`]) byProvinceWard[`${pKey}|${wardKey}`] = row;
    if (oldKey && wardKey && !byProvinceWard[`${oldKey}|${wardKey}`]) byProvinceWard[`${oldKey}|${wardKey}`] = row;
  }
  return { byProvince, byProvinceOld, byProvinceWard };
}

export function lookupSalesArea(index: SalesAreaIndex, sourceProvinceOrText: unknown, ward: unknown): StandardRow {
  const pKey = geoKey(normalizeProvinceText(sourceProvinceOrText));
  const wardKey = geoKey(ward);
  if (!pKey) return {};
  return (wardKey && index.byProvinceWard[`${pKey}|${wardKey}`]) || index.byProvince[pKey] || index.byProvinceOld[pKey] || {};
}

function scanProvinceFromText(value: unknown, index: SalesAreaIndex): string {
  const textKey = geoKey(value);
  if (!textKey) return "";
  const candidates: Array<{ key: string; value: string }> = [];
  const addCandidates = (map: Record<string, StandardRow>) => {
    for (const row of Object.values(map)) {
      const province = normalizeProvinceText(row.province_standard);
      const provinceOld = normalizeProvinceText(row.province_standard_old);
      if (province) candidates.push({ key: geoKey(province), value: province });
      if (provinceOld) candidates.push({ key: geoKey(provinceOld), value: provinceOld });
    }
  };
  addCandidates(index.byProvince);
  addCandidates(index.byProvinceOld);
  let best: { key: string; value: string } | null = null;
  for (const candidate of candidates) {
    if (!candidate.key) continue;
    const words = candidate.key.split(" ").filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = new RegExp(`(^|\\s)${words.join("\\s+")}($|\\s)`);
    if (pattern.test(textKey) && (!best || candidate.key.length > best.key.length)) best = candidate;
  }
  return best?.value ?? "";
}

export function extractProvinceFromText(value: unknown, index: SalesAreaIndex): string {
  const text = normalize(value);
  if (!text) return "";
  const parts = text.split(",").map(normalize).filter(Boolean);
  if (parts.length) {
    const lastPart = normalizeProvinceText(parts[parts.length - 1]);
    if (lookupSalesArea(index, lastPart, {}).business_unit_location) return lastPart;
  }
  const scanned = scanProvinceFromText(text, index);
  if (scanned) return scanned;
  return parts.length ? normalizeProvinceText(parts[parts.length - 1]) : normalizeProvinceText(text);
}

export function enrichGeoFields(rows: StandardRow[], index: SalesAreaIndex): void {
  for (const row of rows) {
    if (!normalize(row.province_invoice)) row.province_invoice = extractProvinceFromText(row.invoice_address, index);
    if (!normalize(row.business_unit_location)) {
      let area = normalize(lookupSalesArea(index, row.province_invoice, row.ward).business_unit_location);
      if (!area) area = normalize(lookupSalesArea(index, row.province, row.ward).business_unit_location);
      row.business_unit_location = area;
    }
  }
}
