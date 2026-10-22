-- =====================================================================
-- Migratsiya 002: v1 (joriy) -> v2 (yangi sxema). Bitta tranzaksiya.
-- Oldin: pg_dump bilan zaxira oling!
-- =====================================================================
BEGIN;
SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN CREATE TYPE timerange AS RANGE (subtype = time);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 0) Tekshiruv: katta-kichik harf bo'yicha takror loginlar bo'lsa to'xtaymiz
DO $$ BEGIN
  IF EXISTS (SELECT lower(login) FROM users GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Takror loginlar bor (katta-kichik harf farqi). Avval tozalang.';
  END IF;
END $$;

-- 1) users
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','dekanat','teacher','tyutor','xodim','student'));
ALTER TABLE users
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
  ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE users DROP CONSTRAINT users_login_key;
CREATE UNIQUE INDEX ux_users_login_lower ON users (lower(login));
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- 2) student_info: id olib tashlanadi, user_id = PK, guruh -> varchar
ALTER TABLE student_info DROP CONSTRAINT student_info_pkey;
ALTER TABLE student_info DROP CONSTRAINT student_info_user_id_key;
ALTER TABLE student_info DROP COLUMN id;
ALTER TABLE student_info ADD PRIMARY KEY (user_id);
ALTER TABLE student_info
  ALTER COLUMN guruh TYPE VARCHAR(30) USING guruh::text,
  ALTER COLUMN kurs  TYPE SMALLINT;
ALTER TABLE student_info ADD CONSTRAINT student_info_tg_user_key UNIQUE (tg_user);
CREATE INDEX ix_student_guruh ON student_info (guruh);

-- 3) teacher_info / dekanat_user_info
ALTER TABLE teacher_info DROP CONSTRAINT teacher_info_pkey;
ALTER TABLE teacher_info DROP CONSTRAINT teacher_info_user_id_key;
ALTER TABLE teacher_info DROP COLUMN id;
ALTER TABLE teacher_info ADD PRIMARY KEY (user_id);
ALTER TABLE teacher_info ADD CONSTRAINT teacher_info_tg_user_key UNIQUE (tg_user);

ALTER TABLE dekanat_user_info DROP CONSTRAINT dekanat_user_info_pkey;
ALTER TABLE dekanat_user_info DROP CONSTRAINT dekanat_user_info_user_id_key;
ALTER TABLE dekanat_user_info DROP COLUMN id;
ALTER TABLE dekanat_user_info ADD PRIMARY KEY (user_id);
ALTER TABLE dekanat_user_info ALTER COLUMN lavozim TYPE VARCHAR(150) USING lavozim::text;
ALTER TABLE dekanat_user_info ADD CONSTRAINT dekanat_user_info_tg_user_key UNIQUE (tg_user);

-- 4) Yangi ma'lumotnoma jadvallari
CREATE TABLE bolimlar (
  id BIGSERIAL PRIMARY KEY,
  nomi VARCHAR(200) NOT NULL,
  turi VARCHAR(30) NOT NULL CHECK (turi IN ('fakultet','dekanat','kafedra','bolim','markaz')),
  parent_id BIGINT REFERENCES bolimlar(id) ON DELETE RESTRICT,
  xona VARCHAR(50),
  status BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE NULLS NOT DISTINCT (parent_id, nomi)
);
CREATE INDEX ix_bolimlar_parent ON bolimlar (parent_id);

CREATE TABLE xodim_bolim (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bolim_id BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  lavozim VARCHAR(150),
  asosiy BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (user_id, bolim_id)
);
CREATE UNIQUE INDEX ux_xodim_bolim_asosiy ON xodim_bolim (user_id) WHERE asosiy;
CREATE INDEX ix_xodim_bolim_bolim ON xodim_bolim (bolim_id);

CREATE TABLE murojaat_turlari (
  id BIGSERIAL PRIMARY KEY,
  bolim_id BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  nomi VARCHAR(200) NOT NULL,
  UNIQUE (bolim_id, nomi)
);

CREATE TABLE tyutor_guruh (
  id BIGSERIAL PRIMARY KEY,
  tyutor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guruh VARCHAR(30) NOT NULL,
  UNIQUE (tyutor_id, guruh)
);

CREATE TABLE qabul_istisno (
  id BIGSERIAL PRIMARY KEY,
  xodim_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sana DATE NOT NULL,
  sabab VARCHAR(255),
  UNIQUE (xodim_id, sana)
);

-- 5) Mavjud xodimlarni vaqtinchalik bo'limga biriktiramiz (keyin admin to'g'rilaydi)
INSERT INTO bolimlar (nomi, turi) VALUES ('Dekanat (migratsiya)', 'dekanat');
INSERT INTO xodim_bolim (user_id, bolim_id, lavozim, asosiy)
SELECT u.id, (SELECT id FROM bolimlar WHERE nomi = 'Dekanat (migratsiya)'), d.lavozim, TRUE
  FROM users u LEFT JOIN dekanat_user_info d ON d.user_id = u.id
 WHERE u.role IN ('teacher','dekanat');

-- 6) qabul_vaqti: umumiy vaqt "hovuzi" -> har bir xodimning shabloni
ALTER TABLE qabul_vaqti RENAME TO qabul_vaqti_v1;
CREATE TABLE qabul_vaqti (
  id BIGSERIAL PRIMARY KEY,
  xodim_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bolim_id BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  hafta_kuni SMALLINT NOT NULL CHECK (hafta_kuni BETWEEN 1 AND 7),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_min SMALLINT CHECK (slot_min BETWEEN 5 AND 240),
  max_navbat SMALLINT NOT NULL CHECK (max_navbat BETWEEN 1 AND 500),
  status BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (end_time > start_time),
  CHECK (end_time <= TIME '23:59'),
  FOREIGN KEY (xodim_id, bolim_id) REFERENCES xodim_bolim (user_id, bolim_id) ON DELETE RESTRICT,
  EXCLUDE USING gist (xodim_id WITH =, hafta_kuni WITH =, timerange(start_time, end_time) WITH &&) WHERE (status)
);
CREATE INDEX ix_qabul_bolim_kun ON qabul_vaqti (bolim_id, hafta_kuni) WHERE status;

-- daqiqa (bigint) -> time; 1440 (24:00) -> 23:59
INSERT INTO qabul_vaqti (xodim_id, bolim_id, hafta_kuni, start_time, end_time, slot_min, max_navbat)
SELECT x.user_id, xb.bolim_id, v.week_date::smallint,
       make_time((v.start_time / 60)::int, (v.start_time % 60)::int, 0),
       CASE WHEN v.end_time >= 1440 THEN TIME '23:59'
            ELSE make_time((v.end_time / 60)::int, (v.end_time % 60)::int, 0) END,
       15,
       GREATEST(1, LEAST(500, (LEAST(v.end_time, 1439) - v.start_time) / 15))
  FROM (SELECT user_id, qabul_vaqti FROM teacher_info      WHERE qabul_vaqti IS NOT NULL
        UNION ALL
        SELECT user_id, qabul_vaqti FROM dekanat_user_info WHERE qabul_vaqti IS NOT NULL) x
  JOIN qabul_vaqti_v1 v ON v.id = x.qabul_vaqti
  JOIN xodim_bolim xb   ON xb.user_id = x.user_id AND xb.asosiy;

ALTER TABLE teacher_info      DROP COLUMN qabul_vaqti;
ALTER TABLE dekanat_user_info DROP COLUMN qabul_vaqti;
DROP TABLE qabul_vaqti_v1;   -- zaxira pg_dump'da bor

-- 7) navbatlar
CREATE TABLE navbatlar (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  qabul_vaqti_id BIGINT NOT NULL REFERENCES qabul_vaqti(id) ON DELETE RESTRICT,
  murojaat_turi_id BIGINT REFERENCES murojaat_turlari(id) ON DELETE RESTRICT,
  sana DATE NOT NULL,
  boshlanish TIME,
  tugash TIME,
  navbat_raqami SMALLINT NOT NULL CHECK (navbat_raqami > 0),
  mavzu TEXT CHECK (char_length(mavzu) <= 1000),
  status VARCHAR(20) NOT NULL DEFAULT 'kutilmoqda'
    CHECK (status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi','kelmadi','rad_etildi','bekor_qilindi')),
  javob_izoh TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((boshlanish IS NULL AND tugash IS NULL) OR tugash > boshlanish)
);
CREATE UNIQUE INDEX ux_navbat_slot_faol ON navbatlar (qabul_vaqti_id, sana, navbat_raqami)
  WHERE status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi','kelmadi');
CREATE UNIQUE INDEX ux_navbat_student_kun ON navbatlar (student_id, qabul_vaqti_id, sana)
  WHERE status IN ('kutilmoqda','tasdiqlandi');
CREATE INDEX ix_navbat_student ON navbatlar (student_id, sana DESC);
CREATE INDEX ix_navbat_qabul_sana ON navbatlar (qabul_vaqti_id, sana);

DROP INDEX IF EXISTS idx_teacher_qabul;
DROP INDEX IF EXISTS idx_dekanat_qabul;

-- 8) Migratsiya jurnali
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO schema_migrations (version) VALUES ('001_init'), ('002_v1_to_v2') ON CONFLICT DO NOTHING;

COMMIT;
