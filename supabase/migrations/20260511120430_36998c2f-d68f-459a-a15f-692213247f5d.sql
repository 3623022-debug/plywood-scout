
CREATE TABLE public.competitors (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.price_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  competitor_id UUID NOT NULL REFERENCES public.competitors(id) ON DELETE CASCADE,
  thickness_mm NUMERIC NOT NULL,
  price NUMERIC,
  currency TEXT,
  product_label TEXT,
  parsed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_snap_competitor ON public.price_snapshots(competitor_id);
CREATE INDEX idx_snap_parsed_at ON public.price_snapshots(parsed_at DESC);

ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read competitors" ON public.competitors FOR SELECT USING (true);
CREATE POLICY "public write competitors" ON public.competitors FOR INSERT WITH CHECK (true);
CREATE POLICY "public update competitors" ON public.competitors FOR UPDATE USING (true);
CREATE POLICY "public delete competitors" ON public.competitors FOR DELETE USING (true);

CREATE POLICY "public read snapshots" ON public.price_snapshots FOR SELECT USING (true);
CREATE POLICY "public write snapshots" ON public.price_snapshots FOR INSERT WITH CHECK (true);
CREATE POLICY "public delete snapshots" ON public.price_snapshots FOR DELETE USING (true);
