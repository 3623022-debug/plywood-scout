import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { parseAllCompetitors } from "@/lib/parser.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Loader2, Trash2, Plus, RefreshCw, ExternalLink } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";

const THICKNESSES = [3, 4, 6, 8, 9, 10, 12, 15, 18, 20];
const MARKS = ["ФК", "ФСФ", "ФОФ"] as const;
const FORMATS = ["1525x1525", "2440x1220"] as const;
const GRADES = ["4/4", "3/4", "2/4", "2/3", "2/2", "1/2"] as const;
type Mark = (typeof MARKS)[number];
type Format = (typeof FORMATS)[number];
type Grade = (typeof GRADES)[number];

export const Route = createFileRoute("/")({
  component: Dashboard,
  head: () => ({
    meta: [
      { title: "Мониторинг цен — Фанера ФК 4/4 ГОСТ 3916.1-2018" },
      {
        name: "description",
        content:
          "Парсер цен конкурентов на фанеру ФК сорт 4/4 по толщинам 3–20 мм.",
      },
    ],
  }),
});

type Competitor = { id: string; name: string; url: string };
type Snapshot = {
  competitor_id: string;
  thickness_mm: number;
  price: number | null;
  currency: string | null;
  product_label: string | null;
  parsed_at: string;
};

function Dashboard() {
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [mark, setMark] = useState<Mark>("ФК");
  const [format, setFormat] = useState<Format>("1525x1525");
  const [grade, setGrade] = useState<Grade>("4/4");
  const parseFn = useServerFn(parseAllCompetitors);

  const load = async () => {
    setLoading(true);
    const [{ data: c }, { data: s }] = await Promise.all([
      supabase.from("competitors").select("*").order("created_at"),
      supabase.from("price_snapshots").select("*"),
    ]);
    setCompetitors((c as Competitor[]) ?? []);
    setSnapshots((s as Snapshot[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addCompetitor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    try {
      new URL(url.trim());
    } catch {
      toast.error("Некорректный URL");
      return;
    }
    const { error } = await supabase
      .from("competitors")
      .insert({ name: name.trim(), url: url.trim() });
    if (error) {
      toast.error(error.message);
      return;
    }
    setName("");
    setUrl("");
    toast.success("Конкурент добавлен");
    load();
  };

  const removeCompetitor = async (id: string) => {
    const { error } = await supabase.from("competitors").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    load();
  };

  const runParser = async () => {
    if (competitors.length === 0) {
      toast.error("Сначала добавьте хотя бы одного конкурента");
      return;
    }
    setParsing(true);
    try {
      const res = await parseFn({ data: { mark, format, grade } });
      if (res.errors.length > 0) {
        toast.warning(
          `Готово: ${res.processed}/${competitors.length}. Ошибки: ${res.errors.join(" | ")}`,
        );
      } else {
        toast.success(`Цены обновлены по ${res.processed} конкурентам`);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка парсинга");
    } finally {
      setParsing(false);
    }
  };

  const cellFor = (competitorId: string, thickness: number) => {
    const snap = snapshots.find(
      (s) => s.competitor_id === competitorId && Number(s.thickness_mm) === thickness,
    );
    if (!snap || snap.price === null || snap.price === undefined) {
      return <span className="text-muted-foreground">—</span>;
    }
    const price = Number(snap.price);
    const cur = snap.currency ?? "RUB";
    return (
      <span title={snap.product_label ?? ""} className="font-medium tabular-nums">
        {price.toLocaleString("ru-RU")} {cur}
      </span>
    );
  };

  const lastUpdate = snapshots
    .map((s) => new Date(s.parsed_at).getTime())
    .reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="min-h-screen bg-background">
      <Toaster richColors position="top-right" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Мониторинг цен конкурентов
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Фанера {mark}, сорт {grade}, формат {format.replace("x", "×")} мм, ГОСТ
            3916.1-2018 · толщины {THICKNESSES.join(", ")} мм
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Добавить конкурента</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={addCompetitor} className="space-y-3">
                <Input
                  placeholder="Название (например, ФанераПром)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                />
                <Input
                  placeholder="https://example.com/catalog/plywood"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  type="url"
                />
                <Button type="submit" className="w-full">
                  <Plus className="mr-2 h-4 w-4" /> Добавить
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Запуск парсера</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Марка</Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={mark}
                    onValueChange={(v) => v && setMark(v as Mark)}
                    className="flex flex-wrap justify-start gap-1"
                  >
                    {MARKS.map((m) => (
                      <ToggleGroupItem key={m} value={m} className="px-3">
                        {m}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Формат, мм</Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={format}
                    onValueChange={(v) => v && setFormat(v as Format)}
                    className="flex flex-wrap justify-start gap-1"
                  >
                    {FORMATS.map((f) => (
                      <ToggleGroupItem key={f} value={f} className="px-3">
                        {f.replace("x", "×")}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Сорт</Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={grade}
                    onValueChange={(v) => v && setGrade(v as Grade)}
                    className="flex flex-wrap justify-start gap-1"
                  >
                    {GRADES.map((g) => (
                      <ToggleGroupItem key={g} value={g} className="px-3">
                        {g}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Соберёт текущие цены по всем конкурентам ({competitors.length}) и
                обновит таблицу сравнения.
              </p>
              {lastUpdate > 0 && (
                <p className="text-xs text-muted-foreground">
                  Последнее обновление:{" "}
                  {new Date(lastUpdate).toLocaleString("ru-RU")}
                </p>
              )}
              <Button
                onClick={runParser}
                disabled={parsing || competitors.length === 0}
                className="w-full"
              >
                {parsing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {parsing ? "Сбор цен..." : "Собрать цены"}
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Конкуренты</CardTitle>
          </CardHeader>
          <CardContent>
            {competitors.length === 0 ? (
              <p className="text-sm text-muted-foreground">Пока никого нет.</p>
            ) : (
              <ul className="divide-y">
                {competitors.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{c.name}</div>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span className="truncate">{c.url}</span>
                      </a>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCompetitor(c.id)}
                      aria-label="Удалить"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">
              Таблица сравнения цен ({mark} {grade}, {format.replace("x", "×")} мм)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 z-10 bg-background px-3 py-2 text-left font-semibold">
                      Конкурент / Толщина
                    </th>
                    {THICKNESSES.map((t) => (
                      <th
                        key={t}
                        className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                      >
                        {t} мм
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {competitors.length === 0 && (
                    <tr>
                      <td
                        colSpan={THICKNESSES.length + 1}
                        className="px-3 py-6 text-center text-muted-foreground"
                      >
                        Добавьте конкурентов и запустите парсер
                      </td>
                    </tr>
                  )}
                  {competitors.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium">
                        {c.name}
                      </td>
                      {THICKNESSES.map((t) => (
                        <td key={t} className="px-3 py-2 text-right">
                          {cellFor(c.id, t)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {loading && (
              <p className="mt-2 text-xs text-muted-foreground">Загрузка...</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
