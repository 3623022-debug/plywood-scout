import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

const THICKNESSES = [3, 4, 6, 8, 9, 10, 12, 15, 18, 20];

const MARKS = ["ФК", "ФСФ", "ФОФ"] as const;
const FORMATS = ["1525x1525", "2440x1220"] as const;
const GRADES = ["4/4", "3/4", "2/4", "2/3", "2/2", "1/2", "1/1", "стр"] as const;
type Mark = (typeof MARKS)[number];
type Format = (typeof FORMATS)[number];
type Grade = (typeof GRADES)[number];

function getAdmin() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function firecrawlScrape(url: string): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");
  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firecrawl ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const md =
    data?.data?.markdown ?? data?.markdown ?? data?.data?.content ?? "";
  return String(md);
}

type ExtractedPrice = {
  thickness_mm: number;
  price: number | null;
  currency: string | null;
  product_label: string | null;
};

type CandidatePrice = ExtractedPrice & {
  unit: "sheet" | "m3" | "unknown";
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\\]/g, "/")
    .replace(/[х×*]/g, "x")
    .replace(/\s+/g, " ")
    .trim();
}

function getGradeRegex(grade: Grade): RegExp {
  if (grade === "стр") return /строительн/iu;

  const romanMap: Record<string, string> = {
    "1": "i",
    "2": "ii",
    "3": "iii",
    "4": "iv",
  };
  const [left, right] = grade.split("/");
  const leftAlt = `${left}|${romanMap[left]}`;
  const rightAlt = `${right}|${romanMap[right]}`;

  return new RegExp(
    `(?:сорт\\s*)?(?:${leftAlt})\\s*\\/\\s*(?:${rightAlt})(?!\\d)`,
    "iu",
  );
}

function matchesMark(text: string, mark: Mark): boolean {
  const normalized = normalizeText(text);
  if (mark === "ФОФ") {
    return /\bфоф\b|ламинирован/iu.test(normalized);
  }

  return normalized.includes(normalizeText(mark));
}

function matchesFormat(text: string, format: Format): boolean {
  const normalized = normalizeText(text);
  const [a, b] = format.split("x");
  return (
    normalized.includes(`${a}x${b}`) || normalized.includes(`${b}x${a}`)
  );
}

function matchesGrade(text: string, grade: Grade): boolean {
  return getGradeRegex(grade).test(normalizeText(text));
}

function parseCurrency(value: string | undefined): string | null {
  const normalized = normalizeText(value ?? "");
  if (!normalized) return null;
  if (normalized.includes("usd")) return "USD";
  if (normalized.includes("eur")) return "EUR";
  if (normalized.includes("руб") || normalized.includes("rur") || normalized.includes("rub") || normalized.includes("₽")) {
    return "RUB";
  }
  return null;
}

function parseThickness(text: string): number | null {
  const match = normalizeText(text).match(/(?:толщина\s*)?(\d+(?:[.,]\d+)?)\s*мм/iu);
  if (!match) return null;

  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function getUnitPriority(unit: CandidatePrice["unit"]): number {
  if (unit === "sheet") return 3;
  if (unit === "m3") return 2;
  return 1;
}

function chooseBetterCandidate(
  current: CandidatePrice | undefined,
  next: CandidatePrice,
): CandidatePrice {
  if (!current || current.price === null) return next;
  if (next.price === null) return current;

  const currentPriority = getUnitPriority(current.unit);
  const nextPriority = getUnitPriority(next.unit);
  if (nextPriority !== currentPriority) {
    return nextPriority > currentPriority ? next : current;
  }

  return next.price < current.price ? next : current;
}

function pickProductLabel(row: string): string | null {
  const matches = Array.from(
    row.matchAll(/\[([^\]]*фанер[^\]]*)\]\([^)]*\)/giu),
  ).map((match) => match[1].replace(/\\+/g, "/").trim());

  if (matches.length === 0) return null;

  return matches.sort((a, b) => {
    const score = (label: string) => {
      let value = label.length;
      if (/сорт|строительн|фк|фсф|фоф|ламинирован/iu.test(label)) value += 100;
      if (/\d+\s*мм/iu.test(label)) value += 50;
      if (/\d{3,4}\s*[xх×*]\s*\d{3,4}/iu.test(label)) value += 50;
      return value;
    };

    return score(b) - score(a);
  })[0];
}

function extractPricesHeuristically(
  markdown: string,
  mark: Mark,
  format: Format,
  grade: Grade,
): ExtractedPrice[] {
  const byThickness = new Map<number, CandidatePrice>();
  for (const t of THICKNESSES) {
    byThickness.set(t, {
      thickness_mm: t,
      price: null,
      currency: null,
      product_label: null,
      unit: "unknown",
    });
  }

  const rows = markdown
    .split("\n")
    .filter((line) => line.includes("|") && /фанер/iu.test(line) && /(руб|₽|usd|eur)/iu.test(line));

  for (const row of rows) {
    const label = pickProductLabel(row);
    if (!label) continue;

    const searchable = `${label} ${row}`;
    if (!matchesMark(searchable, mark)) continue;
    if (!matchesFormat(searchable, format)) continue;
    if (!matchesGrade(searchable, grade)) continue;

    const thickness = parseThickness(searchable);
    if (!thickness || !THICKNESSES.includes(thickness)) continue;

    const priceMatch = row.match(
      /(\d[\d\s]*(?:[.,]\d+)?)\s*(?:<br>\s*)?(руб|₽|RUB|RUR|USD|EUR)\s*(?:\/\s*(лист|м3|м³|m3))?/iu,
    );
    if (!priceMatch) continue;

    const price = Number(priceMatch[1].replace(/\s+/g, "").replace(",", "."));
    if (!Number.isFinite(price)) continue;

    const unitRaw = normalizeText(priceMatch[3] ?? "");
    const candidate: CandidatePrice = {
      thickness_mm: thickness,
      price,
      currency: parseCurrency(priceMatch[2]),
      product_label: label,
      unit: unitRaw.includes("лист") ? "sheet" : unitRaw ? "m3" : "unknown",
    };

    byThickness.set(
      thickness,
      chooseBetterCandidate(byThickness.get(thickness), candidate),
    );
  }

  return Array.from(byThickness.values()).map(({ unit: _unit, ...item }) => item);
}

async function extractPricesWithAI(
  markdown: string,
  competitorName: string,
  mark: Mark,
  format: Format,
  grade: Grade,
): Promise<ExtractedPrice[]> {
  const heuristicResults = extractPricesHeuristically(markdown, mark, format, grade);
  if (heuristicResults.some((item) => item.price !== null)) {
    return heuristicResults;
  }

  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

  const trimmed = markdown.slice(0, 60000);

  const markHint =
    mark === "ФОФ"
      ? `марке ФОФ (учитывай также позиции, обозначенные как "ламинированная" / "ламинированная фанера" — считай их ФОФ)`
      : `марке ${mark}`;
  const formatHuman = format.replace("x", "×");
  const ignoreMarks = MARKS.filter((m) => m !== mark)
    .map((m) => (m === "ФОФ" ? "ФОФ/ламинированную" : m))
    .join(", ");

  const gradeHuman =
    grade === "стр"
      ? `строительная (ищи позиции, где явно указано слово "строительная" — это и есть искомый сорт)`
      : `${grade}`;
  const systemPrompt = `Ты извлекаешь цены на фанеру из текста каталога конкурента "${competitorName}".
Целевой товар: фанера ${mark}, сорт ${grade}, формат ${formatHuman} мм, ГОСТ 3916.1-2018.
Нужны цены за лист (или за м³ если за лист нет) для толщин: ${THICKNESSES.join(", ")} мм.
Верни ТОЛЬКО JSON-массив объектов вида:
{ "thickness_mm": число, "price": число | null, "currency": "RUB"|"USD"|"EUR"|null, "product_label": "краткое описание позиции" | null }
По одной записи на каждую толщину из списка. Если для толщины подходящей цены не нашлось — price: null.
Бери только позиции, явно соответствующие ${markHint}, сорту ${gradeHuman} и формату ${formatHuman} мм (или максимально близкие). Игнорируй другие марки (${ignoreMarks}) и другие сорта/форматы.`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: trimmed },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AI ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "[]";

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = [];
  }
  let arr: unknown[] = [];
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        arr = v;
        break;
      }
    }
  }

  const byThickness = new Map<number, ExtractedPrice>();
  for (const t of THICKNESSES) {
    byThickness.set(t, {
      thickness_mm: t,
      price: null,
      currency: null,
      product_label: null,
    });
  }
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const t = Number(o.thickness_mm);
    if (!THICKNESSES.includes(t)) continue;
    const price =
      o.price === null || o.price === undefined || o.price === ""
        ? null
        : Number(o.price);
    byThickness.set(t, {
      thickness_mm: t,
      price: Number.isFinite(price) ? (price as number) : null,
      currency: typeof o.currency === "string" ? o.currency : null,
      product_label:
        typeof o.product_label === "string" ? o.product_label : null,
    });
  }
  const aiResults = Array.from(byThickness.values());
  if (aiResults.some((item) => item.price !== null)) {
    return aiResults;
  }

  return heuristicResults;
}

export const parseAllCompetitors = createServerFn({ method: "POST" })
  .inputValidator((data: { mark: Mark; format: Format; grades: Grade[] }) => {
    if (!MARKS.includes(data.mark)) throw new Error("Invalid mark");
    if (!FORMATS.includes(data.format)) throw new Error("Invalid format");
    if (!Array.isArray(data.grades) || data.grades.length === 0)
      throw new Error("Select at least one grade");
    for (const g of data.grades) {
      if (!GRADES.includes(g)) throw new Error("Invalid grade");
    }
    return data;
  })
  .handler(async ({ data }) => {
    const admin = getAdmin();
    const { data: competitors, error } = await admin
      .from("competitors")
      .select("id, name, url");
    if (error) throw new Error(error.message);
    if (!competitors || competitors.length === 0) {
      return { ok: true, processed: 0, errors: [] as string[] };
    }

    const errors: string[] = [];
    let processed = 0;

    for (const c of competitors) {
      try {
        const md = await firecrawlScrape(c.url);
        for (const grade of data.grades) {
          const prices = await extractPricesWithAI(
            md,
            c.name,
            data.mark,
            data.format,
            grade,
          );
          await admin
            .from("price_snapshots")
            .delete()
            .eq("competitor_id", c.id)
            .eq("grade", grade);
          const rows = prices.map((p) => ({
            competitor_id: c.id,
            thickness_mm: p.thickness_mm,
            price: p.price,
            currency: p.currency,
            product_label: p.product_label,
            grade,
          }));
          const { error: insErr } = await admin
            .from("price_snapshots")
            .insert(rows);
          if (insErr) throw new Error(insErr.message);
        }
        processed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${c.name}: ${msg}`);
      }
    }

    return { ok: true, processed, errors };
  });
