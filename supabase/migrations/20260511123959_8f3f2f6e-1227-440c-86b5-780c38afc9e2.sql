ALTER TABLE public.price_snapshots ADD COLUMN IF NOT EXISTS grade text NOT NULL DEFAULT '4/4';
CREATE INDEX IF NOT EXISTS idx_price_snapshots_grade ON public.price_snapshots(grade);