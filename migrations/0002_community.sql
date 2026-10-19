CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closes_at INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
CREATE INDEX IF NOT EXISTS poll_votes_poll ON poll_votes(poll_id);

CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  district_id TEXT,
  topic TEXT NOT NULL CHECK(topic IN ('question','idea','story')),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 3 AND 700),
  status TEXT NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden','removed')),
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_posts_recent ON community_posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS community_posts_district ON community_posts(district_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS community_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'visible' CHECK(status IN ('visible','hidden','removed')),
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_comments_post ON community_comments(post_id, status, created_at);

CREATE TABLE IF NOT EXISTS community_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('post','comment')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(reporter_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS user_rate_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  action_count INTEGER NOT NULL,
  PRIMARY KEY(user_id, action, window_start)
);

CREATE TABLE IF NOT EXISTS game_scores (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, game_id, week_key)
);
CREATE INDEX IF NOT EXISTS game_scores_leaderboard ON game_scores(game_id, week_key, best_score DESC);

INSERT OR IGNORE INTO polls(id, question, description, category, options_json, created_at, closes_at, is_active) VALUES
('rayon-prioriteti-1', 'Rayonunuzda ən çox hansı sahə yaxşılaşmalıdır?', 'Bir cavab seçin. Səsinizi sonra dəyişə bilərsiniz.', 'İnkişaf', '["Yollar və nəqliyyat","Səhiyyə","Təhsil","İş imkanları","İstirahət və mədəniyyət"]', 0, NULL, 1),
('rayon-gormeli-1', 'Rayonunuza gələn qonağa ilk nəyi göstərərdiniz?', 'Yerli tövsiyələri toplayırıq.', 'Yerli həyat', '["Təbiət və mənzərələr","Tarixi məkanlar","Yerli mətbəx","Mədəni tədbirlər","Gündəlik həyat"]', 0, NULL, 1),
('rayon-tedbir-1', 'Növbəti icma mövzusu hansı olsun?', 'Nəticə yeni müzakirə mövzularını seçməyə kömək edəcək.', 'İcma', '["Yerli biznes və xidmətlər","Tarix və yaddaş","Turizm və marşrutlar","Gənclər və idman","İctimai məkanlar"]', 0, NULL, 1);

