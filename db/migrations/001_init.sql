-- =====================================================================
-- Dekanat App — sxema v2 (rasmdagi sxema + tavsiya etilgan cheklovlar)
-- PostgreSQL 14+ (Render: 16)
-- =====================================================================
SET client_min_messages = warning;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- EXCLUDE cheklovi uchun

-- time oralig'i turi (qabul vaqtlari ustma-ust tushmasligi uchun)
DO $$ BEGIN
  CREATE TYPE timerange AS RANGE (subtype = time);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 1. users  (o'zgaradi: role ro'yxati kengayadi)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  ism         VARCHAR(100) NOT NULL,
  familiya    VARCHAR(100) NOT NULL,
  ochestva    VARCHAR(100),
  login       VARCHAR(100) NOT NULL,
  parol       VARCHAR(255) NOT NULL,                 -- bcrypt hash
  role        VARCHAR(20)  NOT NULL
              CHECK (role IN ('admin','dekanat','teacher','tyutor','xodim','student')),
  phone       VARCHAR(20),
  status      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- login katta-kichik harfga sezgir bo'lmasin: "Admin" va "admin" bitta
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_lower ON users (lower(login));
CREATE INDEX IF NOT EXISTS ix_users_role ON users (role);

-- ---------------------------------------------------------------------
-- 2. student_info  (mavjud; user_id endi PK, guruh -> varchar)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_info (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guruh    VARCHAR(30),
  kurs     SMALLINT CHECK (kurs BETWEEN 1 AND 6),
  tg_user  BIGINT UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_student_guruh ON student_info (guruh);

-- ---------------------------------------------------------------------
-- 3. teacher_info  (o'zgaradi: qabul_vaqti ustuni olib tashlandi)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teacher_info (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user  BIGINT UNIQUE
);

-- ---------------------------------------------------------------------
-- 4. dekanat_user_info  (o'zgaradi: qabul_vaqti olib tashlandi, lavozim -> varchar)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dekanat_user_info (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lavozim  VARCHAR(150),
  tg_user  BIGINT UNIQUE
);

-- ---------------------------------------------------------------------
-- 5. tyutor_guruh  (yangi)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tyutor_guruh (
  id         BIGSERIAL PRIMARY KEY,
  tyutor_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guruh      VARCHAR(30) NOT NULL,
  UNIQUE (tyutor_id, guruh)
);
-- Agar bitta guruhga faqat bitta tyutor bo'lsa, quyidagini yoqing:
-- CREATE UNIQUE INDEX ux_tyutor_guruh_guruh ON tyutor_guruh (guruh);

-- ---------------------------------------------------------------------
-- 6. bolimlar  (yangi; daraxt: fakultet -> dekanat/kafedra ...)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bolimlar (
  id         BIGSERIAL PRIMARY KEY,
  nomi       VARCHAR(200) NOT NULL,
  turi       VARCHAR(30)  NOT NULL
             CHECK (turi IN ('fakultet','dekanat','kafedra','bolim','markaz')),
  parent_id  BIGINT REFERENCES bolimlar(id) ON DELETE RESTRICT,
  xona       VARCHAR(50),
  status     BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (parent_id IS NULL OR parent_id <> id),
  UNIQUE NULLS NOT DISTINCT (parent_id, nomi)   -- PG15+
);
CREATE INDEX IF NOT EXISTS ix_bolimlar_parent ON bolimlar (parent_id);

-- ---------------------------------------------------------------------
-- 7. xodim_bolim  (yangi; xodim <-> bo'lim, ko'pga-ko'p)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xodim_bolim (
  id        BIGSERIAL PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  bolim_id  BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  lavozim   VARCHAR(150),
  asosiy    BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (user_id, bolim_id)
);
-- har bir xodimning faqat BITTA asosiy bo'limi bo'ladi
CREATE UNIQUE INDEX IF NOT EXISTS ux_xodim_bolim_asosiy ON xodim_bolim (user_id) WHERE asosiy;
CREATE INDEX IF NOT EXISTS ix_xodim_bolim_bolim ON xodim_bolim (bolim_id);

-- ---------------------------------------------------------------------
-- 8. murojaat_turlari  (yangi)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS murojaat_turlari (
  id        BIGSERIAL PRIMARY KEY,
  bolim_id  BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  nomi      VARCHAR(200) NOT NULL,
  UNIQUE (bolim_id, nomi)
);

-- ---------------------------------------------------------------------
-- 9. qabul_vaqti  (o'zgaradi: endi har bir xodimning haftalik shabloni)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qabul_vaqti (
  id          BIGSERIAL PRIMARY KEY,
  xodim_id    BIGINT   NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bolim_id    BIGINT   NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  hafta_kuni  SMALLINT NOT NULL CHECK (hafta_kuni BETWEEN 1 AND 7),  -- 1=Du ... 7=Ya (ISO)
  start_time  TIME     NOT NULL,
  end_time    TIME     NOT NULL,
  slot_min    SMALLINT CHECK (slot_min BETWEEN 5 AND 240),           -- NULL = jonli navbat rejimi
  max_navbat  SMALLINT NOT NULL CHECK (max_navbat BETWEEN 1 AND 500),
  status      BOOLEAN  NOT NULL DEFAULT TRUE,
  CHECK (end_time > start_time),
  CHECK (end_time <= TIME '23:59'),   -- time + interval 24:00 dan o'tsa 00:00 ga aylanadi
  -- xodim aynan shu bo'limga biriktirilgan bo'lishi shart
  FOREIGN KEY (xodim_id, bolim_id) REFERENCES xodim_bolim (user_id, bolim_id) ON DELETE RESTRICT,
  -- bitta xodimning bir kundagi faol qabul vaqtlari ustma-ust tushmasin
  EXCLUDE USING gist (
    xodim_id WITH =, hafta_kuni WITH =, timerange(start_time, end_time) WITH &&
  ) WHERE (status)
);
CREATE INDEX IF NOT EXISTS ix_qabul_bolim_kun ON qabul_vaqti (bolim_id, hafta_kuni) WHERE status;

-- ---------------------------------------------------------------------
-- 10. qabul_istisno  (yangi; xodim shu sanada qabul qilmaydi)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qabul_istisno (
  id        BIGSERIAL PRIMARY KEY,
  xodim_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sana      DATE   NOT NULL,
  sabab     VARCHAR(255),
  UNIQUE (xodim_id, sana)
);

-- ---------------------------------------------------------------------
-- 11. navbatlar  (yangi; talabaning aniq sanadagi broni)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS navbatlar (
  id                BIGSERIAL PRIMARY KEY,
  student_id        BIGINT   NOT NULL REFERENCES users(id)            ON DELETE RESTRICT,
  qabul_vaqti_id    BIGINT   NOT NULL REFERENCES qabul_vaqti(id)      ON DELETE RESTRICT,
  murojaat_turi_id  BIGINT            REFERENCES murojaat_turlari(id) ON DELETE RESTRICT,
  sana              DATE     NOT NULL,
  boshlanish        TIME,
  tugash            TIME,
  navbat_raqami     SMALLINT NOT NULL CHECK (navbat_raqami > 0),
  mavzu             TEXT     CHECK (char_length(mavzu) <= 1000),
  status            VARCHAR(20) NOT NULL DEFAULT 'kutilmoqda'
                    CHECK (status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi',
                                      'kelmadi','rad_etildi','bekor_qilindi')),
  javob_izoh        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((boshlanish IS NULL AND tugash IS NULL) OR tugash > boshlanish)
);
-- bitta slot/raqam faqat bitta FAOL bronga tegishli
CREATE UNIQUE INDEX IF NOT EXISTS ux_navbat_slot_faol
  ON navbatlar (qabul_vaqti_id, sana, navbat_raqami)
  WHERE status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi','kelmadi');
-- talaba bitta qabulga bir kunda faqat bitta faol bron qila oladi
CREATE UNIQUE INDEX IF NOT EXISTS ux_navbat_student_kun
  ON navbatlar (student_id, qabul_vaqti_id, sana)
  WHERE status IN ('kutilmoqda','tasdiqlandi');
CREATE INDEX IF NOT EXISTS ix_navbat_student ON navbatlar (student_id, sana DESC);
CREATE INDEX IF NOT EXISTS ix_navbat_qabul_sana ON navbatlar (qabul_vaqti_id, sana);

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
