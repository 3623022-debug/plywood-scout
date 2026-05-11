import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

const THICKNESSES = [3, 4, 6, 8, 9, 10, 12, 15, 18, 20];

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

async function extractPricesWithAI(
  markdown: string,
  competitorName: string,
): Promise<ExtractedPrice[]> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

  const trimmed = markdown.slice(0, 60000);

  const systemPrompt = `Ты извлекаешь цены на фанеру из текста каталога конкурента "${competitorName}".
Целевой товар: фанера ФК, сорт 4/4, ГОСТ 3916.1-2018.
Нужны цены за лист (или за м³ если за лист нет) для толщин: ${THICKNESSES.join(", ")} мм.
Верни ТОЛЬКО JSON-массив объектов вида:
{ "thickness_mm": число, "price": число | null, "currency": "RUB"|"USD"|"EUR"|null, "product_label": "краткое описание позиции" | null }
По одной записи на каждую толщину из списка. Если для толщины подходящей цены не нашлось — price: null.
Бери только позиции, явно соответствующие марке ФК и сорту 4/4 (или максимально близкие). Игнорируй ФСФ, ламинированную, березовую сорта 1/1, 2/2 и т.п.`;

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
  return Array.from(byThickness.values());
}

export const parseAllCompetitors = createServerFn({ method: "POST" }).handler(
  async () => {
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
        const prices = await extractPricesWithAI(md, c.name);

        await admin
          .from("price_snapshots")
          .delete()
          .eq("competitor_id", c.id);

        const rows = prices.map((p) => ({
          competitor_id: c.id,
          thickness_mm: p.thickness_mm,
          price: p.price,
          currency: p.currency,
          product_label: p.product_label,
        }));
        const { error: insErr } = await admin
          .from("price_snapshots")
          .insert(rows);
        if (insErr) throw new Error(insErr.message);
        processed++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${c.name}: ${msg}`);
      }
    }

    return { ok: true, processed, errors };
  },
);
