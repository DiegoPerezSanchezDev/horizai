-- HorizAI / Fase 8A
-- Seed idempotente de regiones, categorías y fuentes de ejemplo.

insert into public.regions (code, name, latitude, longitude)
values
  ('GLOBAL', 'Global', 20.00000, 0.00000),
  ('US', 'EE. UU.', 39.82830, -98.57950),
  ('EUROPE', 'Europa', 54.52600, 15.25510),
  ('CHINA', 'China', 35.86170, 104.19540),
  ('INDIA', 'India', 20.59370, 78.96290),
  ('SPAIN', 'España', 40.46370, -3.74920),
  ('LATAM', 'LatAm', -8.78320, -55.49150),
  ('JAPAN', 'Japón', 36.20480, 138.25290),
  ('SOUTH-KOREA', 'Corea del Sur', 35.90780, 127.76690),
  ('UK', 'Reino Unido', 55.37810, -3.43600),
  ('MIDDLE-EAST', 'Oriente Medio', 29.29850, 42.55000)
on conflict (code) do update set
  name = excluded.name,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  updated_at = now();

insert into public.categories (slug, name)
values
  ('modelos', 'Modelos'),
  ('empresas', 'Empresas'),
  ('chips', 'Chips'),
  ('regulacion', 'Regulación'),
  ('startups', 'Startups'),
  ('investigacion', 'Investigación'),
  ('talento', 'Talento'),
  ('innovacion', 'Innovación')
on conflict (slug) do update set
  name = excluded.name,
  updated_at = now();

insert into public.sources (name, url, source_type, country_code, language, priority)
values
  ('MIT Technology Review', 'https://www.technologyreview.com/', 'website', 'US', 'en', 90),
  ('The Verge AI', 'https://www.theverge.com/ai-artificial-intelligence', 'website', 'US', 'en', 80),
  ('TechCrunch AI', 'https://techcrunch.com/category/artificial-intelligence/', 'website', 'US', 'en', 80),
  ('Ars Technica AI', 'https://arstechnica.com/ai/', 'website', 'US', 'en', 75),
  ('VentureBeat AI', 'https://venturebeat.com/ai/', 'website', 'US', 'en', 70),
  ('Hugging Face Blog', 'https://huggingface.co/blog', 'website', 'US', 'en', 75),
  ('Google AI Blog', 'https://blog.google/technology/ai/', 'website', 'US', 'en', 70),
  ('OpenAI News', 'https://openai.com/news/', 'website', 'US', 'en', 70),
  ('DeepMind Blog', 'https://deepmind.google/discover/blog/', 'website', 'UK', 'en', 70),
  ('Nature Machine Intelligence', 'https://www.nature.com/natmachintell/', 'website', 'UK', 'en', 80),
  ('Sifted AI', 'https://sifted.eu/sector/ai', 'website', 'EU', 'en', 70),
  ('EL PAÍS Tecnología', 'https://elpais.com/tecnologia/', 'website', 'ES', 'es', 80),
  ('Xataka', 'https://www.xataka.com/robotica-e-ia', 'website', 'ES', 'es', 75),
  ('MIT Technology Review en español', 'https://www.technologyreview.es/', 'website', 'ES', 'es', 75),
  ('Rest of World AI', 'https://restofworld.org/topic/artificial-intelligence/', 'website', null, 'en', 65)
on conflict (url) do update set
  name = excluded.name,
  source_type = excluded.source_type,
  country_code = excluded.country_code,
  language = excluded.language,
  priority = excluded.priority,
  updated_at = now();
