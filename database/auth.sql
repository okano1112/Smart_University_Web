CREATE SCHEMA IF NOT EXISTS bimclub_auth;

CREATE TABLE IF NOT EXISTS bimclub_auth.admin_account (
    id smallint PRIMARY KEY CHECK (id = 1),
    username text NOT NULL CHECK (username ~ '^[a-zA-Z0-9._-]{1,64}$'),
    salt text NOT NULL CHECK (salt ~ '^[a-f0-9]{32}$'),
    hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$')
);

CREATE TABLE IF NOT EXISTS bimclub_auth.sessions (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    origin text NOT NULL,
    account_hash text NOT NULL,
    expires_at bigint NOT NULL,
    created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON bimclub_auth.sessions (expires_at);
