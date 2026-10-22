-- Tavsiya etilgan qo'shimcha jadvallar (T-04, T-08, T-09, T-10, T-12)
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  amal       VARCHAR(50)  NOT NULL,          -- 'navbat.status', 'user.create', 'login.fail' ...
  obyekt     VARCHAR(50),                    -- 'navbatlar'
  obyekt_id  BIGINT,
  eski       JSONB,
  yangi      JSONB,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_obyekt ON audit_log (obyekt, obyekt_id);
CREATE INDEX IF NOT EXISTS ix_audit_vaqt   ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS bayramlar (
  sana  DATE PRIMARY KEY,
  nomi  VARCHAR(150) NOT NULL
);

CREATE TABLE IF NOT EXISTS sozlamalar (
  kalit  VARCHAR(60) PRIMARY KEY,
  qiymat JSONB NOT NULL
);
INSERT INTO sozlamalar VALUES
  ('yozilish_oynasi_kun', '14'), ('bugun_yopilish_daq', '30'), ('max_faol_bron', '3'),
  ('bekor_muddati_soat', '1'), ('tasdiqlash_rejimi', '"avto"')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS bildirishnomalar (          -- outbox
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matn        TEXT   NOT NULL,
  holat       VARCHAR(10) NOT NULL DEFAULT 'kutmoqda' CHECK (holat IN ('kutmoqda','yuborildi','xato')),
  urinishlar  SMALLINT NOT NULL DEFAULT 0,
  keyingi_urinish TIMESTAMPTZ NOT NULL DEFAULT now(),
  xato        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  yuborilgan  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_outbox_navbat ON bildirishnomalar (keyingi_urinish) WHERE holat = 'kutmoqda';

CREATE TABLE IF NOT EXISTS tg_link_tokens (
  token      VARCHAR(64) PRIMARY KEY,               -- crypto.randomBytes(24).toString('base64url')
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Outbox ishchisi: bir nechta ishchi bir xabarni ikki marta olmasligi uchun
-- SELECT ... FROM bildirishnomalar WHERE holat='kutmoqda' AND keyingi_urinish <= now()
--   ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED;
